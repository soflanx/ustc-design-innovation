import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCourseAttentionItems } from '../src/lib/course-attention';
import type { AssignmentHomeAudience, AssignmentHomeSource } from '../src/lib/teaching-presentation';

const now = new Date('2030-10-01T08:00:00Z');
const options = (audience: AssignmentHomeAudience) => ({ audience, offeringStatus: 'ACTIVE' as const, now });
const summary = (pending: number, total = 2) => ({
  totalExpectedCount: total, submittedCount: pending, pendingFeedbackCount: pending, feedbackCount: 0, completedReviewCount: 0, unknownReviewCount: 0,
});
function item(id: string, changes: Partial<AssignmentHomeSource> = {}): AssignmentHomeSource {
  return {
    id, offeringId: 'course', title: id, mode: 'INDIVIDUAL', status: 'PUBLISHED',
    dueAt: new Date('2030-10-03T08:00:00Z'),
    summary: summary(0), mineSummary: null,
    progress: { state: 'NOT_SUBMITTED', reviewState: null, latestVersionId: null, feedbackCount: 0 },
    ...changes,
  };
}

test('学生补充事项排除本次任务，只提示可提交任务、未分组及已有反馈', () => {
  const assignments = [
    item('current-task'),
    item('open-task'),
    item('no-deadline', { dueAt: null }),
    item('ungrouped', { mode: 'GROUP', dueAt: new Date('2030-10-02T08:00:00Z'), progress: { state: 'UNGROUPED', reviewState: null, latestVersionId: null, feedbackCount: 0 } }),
    item('submitted', { progress: { state: 'SUBMITTED', reviewState: 'PENDING' as const, latestVersionId: 'submitted', feedbackCount: 0 } }),
    item('deadline-reached', { dueAt: new Date(now) }),
    item('ended-task', { status: 'ARCHIVED' }),
    item('draft', { status: 'DRAFT' }),
    item('no-progress', { progress: null }),
  ];
  const rows = getCourseAttentionItems(assignments, ['current-task', 'current-task'], options('STUDENT'));
  assert.deepEqual(rows.map(row => row.id), ['ungrouped', 'open-task', 'no-deadline']);
  assert.equal(rows[0].home.href, '/courses/course/groups');
  assert.ok(rows.slice(1).every(row => row.home.href.endsWith('#submission')));
  assert.ok(rows.every(row => row.home.actionable));
});

test('历史任务已有反馈保留版本入口，本次反馈不重复且不宣称未读', () => {
  const feedback = { state: 'FEEDBACK_AVAILABLE' as const, reviewState: 'PENDING' as const, latestVersionId: 'reviewed-version', feedbackCount: 2 };
  const rows = getCourseAttentionItems([
    item('current-feedback', { progress: feedback }),
    item('past-feedback', { dueAt: new Date('2030-09-30T08:00:00Z'), progress: feedback }),
    item('ended-feedback', { status: 'ARCHIVED', dueAt: new Date('2030-09-01T08:00:00Z'), progress: feedback }),
    item('open-unsubmitted', { dueAt: null }),
    item('draft-feedback', { status: 'DRAFT', progress: feedback }),
  ], ['current-feedback'], options('STUDENT'));
  assert.deepEqual(rows.map(row => row.id), ['open-unsubmitted', 'ended-feedback', 'past-feedback']);
  for (const row of rows.slice(1)) {
    assert.equal(row.home.actionLabel, '查看已有反馈');
    assert.match(row.home.href, /#version-reviewed-version$/);
    assert.match(row.home.statusLabel, /已有 2 条反馈/);
    assert.doesNotMatch(row.home.statusLabel + row.home.actionLabel, /新反馈|未读/);
  }
});

test('教师仅补充有待评阅提交的其他作业，截止与作业结束仍可继续反馈', () => {
  const rows = getCourseAttentionItems([
    item('current-pending', { summary: summary(2) }),
    item('draft', { status: 'DRAFT' }),
    item('draft-with-pending', { status: 'DRAFT', summary: summary(1) }),
    item('no-pending'),
    item('no-summary', { summary: null }),
    item('past', { dueAt: new Date('2030-09-30T08:00:00Z'), summary: summary(1) }),
    item('ended', { status: 'ARCHIVED', dueAt: new Date('2030-09-01T08:00:00Z'), summary: summary(1) }),
  ], ['current-pending'], options('TEACHER'));
  assert.deepEqual(rows.map(row => row.id), ['ended', 'past']);
  assert.ok(rows.every(row => row.home.href.endsWith('?view=pending&scope=all')));
  assert.ok(rows.every(row => row.home.actionLabel === '查看待评阅'));
});

test('助教只看到自己负责范围的待评阅，不回退到全班统计', () => {
  const rows = getCourseAttentionItems([
    item('all-only', { summary: summary(99, 100), mineSummary: summary(0) }),
    item('mine-unknown', { summary: summary(99, 100), mineSummary: null }),
    item('mine-empty', { summary: summary(99, 100), mineSummary: summary(0, 0) }),
    item('current-mine', { mineSummary: summary(1) }),
    item('mine-pending', { dueAt: new Date('2030-09-30T08:00:00Z'), summary: summary(99, 100), mineSummary: summary(1) }),
  ], ['current-mine'], options('TA'));
  assert.deepEqual(rows.map(row => row.id), ['mine-pending']);
  assert.equal(rows[0].home.href, '/courses/course/assignments/mine-pending?view=pending&scope=mine');
  assert.match(rows[0].home.statusLabel, /我负责范围已交 1\/2 人 · 待评阅 1/);
  assert.doesNotMatch(rows[0].home.statusLabel, /99|100|全班/);
});

test('归档和筹备课程不产生待办，管理员也不获得教学评阅待办', () => {
  const assignments = [item('actionable', {
    summary: summary(2), mineSummary: summary(1),
    progress: { state: 'FEEDBACK_AVAILABLE', reviewState: 'PENDING' as const, latestVersionId: 'version', feedbackCount: 1 },
  })];
  for (const audience of ['STUDENT', 'TEACHER', 'TA', 'ADMIN'] as const) {
    for (const offeringStatus of ['DRAFT', 'ARCHIVED'] as const) {
      assert.deepEqual(getCourseAttentionItems(assignments, [], { ...options(audience), offeringStatus }), []);
    }
  }
  assert.deepEqual(getCourseAttentionItems(assignments, [], options('ADMIN')), []);
});

test('补充事项稳定排序且不修改输入，不在数据层截断更多事项', () => {
  const original = [
    { ...item('b', { title: '同名' }), extra: 'retained' },
    { ...item('no-deadline', { dueAt: null }), extra: 'retained' },
    { ...item('a', { title: '同名' }), extra: 'retained' },
    { ...item('earlier', { dueAt: new Date('2030-10-02T08:00:00Z') }), extra: 'retained' },
  ];
  const before = original.map(row => row.id);
  const expected = ['earlier', 'a', 'b', 'no-deadline'];
  const first = getCourseAttentionItems(original, [], options('STUDENT'));
  assert.deepEqual(first.map(row => row.id), expected);
  assert.deepEqual(getCourseAttentionItems([...original].reverse(), [], options('STUDENT')).map(row => row.id), expected);
  assert.deepEqual(original.map(row => row.id), before);
  assert.ok(original.every(row => !('home' in row)));
  assert.ok(first.every(row => row.extra === 'retained'));
});

test('取消作业从所有身份的常规待办移除，包括已有反馈与待评阅记录', () => {
  const assignments = [
    item('cancelled-missing', { status: 'CANCELLED' }),
    item('cancelled-group', { status: 'CANCELLED', mode: 'GROUP', progress: { state: 'UNGROUPED', reviewState: null, latestVersionId: null, feedbackCount: 0 } }),
    item('cancelled-feedback', {
      status: 'CANCELLED', summary: summary(2, 0), mineSummary: summary(1, 0),
      progress: { state: 'CANCELLED', reviewState: 'PENDING' as const, latestVersionId: 'retained-version', feedbackCount: 2 },
    }),
    item('cancelled-stale-progress', { status: 'CANCELLED', progress: { state: 'FEEDBACK_AVAILABLE', reviewState: 'PENDING' as const, latestVersionId: 'retained-version', feedbackCount: 1 } }),
  ];
  for (const audience of ['STUDENT', 'TEACHER', 'TA', 'ADMIN'] as const) {
    assert.deepEqual(getCourseAttentionItems(assignments, [], options(audience)), []);
  }
});
