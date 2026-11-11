import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAssignmentHomeItems, progressLabel, summaryLabel, type AssignmentHomeSource, type AssignmentHomeAudience } from '../src/lib/teaching-presentation';

const now = new Date('2030-10-01T08:00:00Z');
const summary = (pending = 0, total = 2) => ({
  totalExpectedCount: total, submittedCount: pending, pendingFeedbackCount: pending, feedbackCount: 0, completedReviewCount: 0, unknownReviewCount: 0,
});
function item(id: string, changes: Partial<AssignmentHomeSource> = {}): AssignmentHomeSource {
  return {
    id, offeringId: 'course', title: id, mode: 'INDIVIDUAL', status: 'PUBLISHED',
    dueAt: new Date('2030-10-03T08:00:00Z'),
    summary: summary(), mineSummary: null,
    progress: { state: 'NOT_SUBMITTED', reviewState: null, latestVersionId: null, feedbackCount: 0 },
    ...changes,
  };
}
const options = (audience: AssignmentHomeAudience) => ({ audience, offeringStatus: 'ACTIVE' as const, now });

test('学生开放未交按临近截止优先，已有反馈次之，已交和关闭作业后置', () => {
  const assignments = [
    item('closed', { dueAt: new Date('2030-09-30T08:00:00Z') }),
    item('submitted', { progress: { state: 'SUBMITTED', reviewState: 'PENDING' as const, latestVersionId: 'submitted-version', feedbackCount: 0 } }),
    item('feedback', { progress: { state: 'FEEDBACK_AVAILABLE', reviewState: 'PENDING' as const, latestVersionId: 'feedback-version', feedbackCount: 2 } }),
    item('no-deadline', { dueAt: null }),
    item('later'),
    item('near', { dueAt: new Date('2030-10-01T09:00:00Z') }),
    item('ended', { status: 'ARCHIVED', dueAt: new Date('2030-09-01T08:00:00Z') }),
  ];
  const ordered = getAssignmentHomeItems(assignments, options('STUDENT'));
  assert.deepEqual(ordered.slice(0, 5).map(row => row.id), ['near', 'later', 'no-deadline', 'feedback', 'submitted']);
  assert.ok(ordered.slice(5).every(row => !row.home.actionable));
  assert.equal(ordered[0].home.actionLabel, '去提交作业');
  assert.ok(ordered[0].home.href.endsWith('#submission'));
  assert.equal(ordered[0].home.readHref, ordered[0].home.href.split('#')[0]);
  const feedback = ordered.find(row => row.id === 'feedback')!.home;
  assert.match(feedback.statusLabel, /已有 2 条反馈/);
  assert.doesNotMatch(feedback.statusLabel + feedback.actionLabel, /新反馈|未读/);
  assert.equal(feedback.href, '/courses/course/assignments/feedback#version-feedback-version');
  assert.equal(ordered.find(row => row.id === 'submitted')!.home.actionable, false);
});

test('未分组提示保持可行动；截止边界和筹备课程不得引导学生提交', () => {
  const ungrouped = item('ungrouped', { mode: 'GROUP', progress: { state: 'UNGROUPED', reviewState: null, latestVersionId: null, feedbackCount: 0 } });
  const pending = getAssignmentHomeItems([ungrouped], options('STUDENT'))[0];
  assert.equal(pending.home.actionable, true);
  assert.equal(pending.home.href, '/courses/course/groups');
  assert.equal(pending.home.actionLabel, '查看组队安排');
  assert.equal(pending.home.readHref, '/courses/course/assignments/ungrouped');
  assert.match(pending.home.statusLabel, /尚未分组/);
  const atDeadline = getAssignmentHomeItems([item('boundary', { dueAt: new Date(now) })], options('STUDENT'))[0];
  assert.equal(atDeadline.home.actionable, false);
  assert.doesNotMatch(atDeadline.home.actionLabel, /提交/);
  const preparation = getAssignmentHomeItems([item('published'), ungrouped], {
    ...options('STUDENT'), offeringStatus: 'DRAFT',
  });
  assert.ok(preparation.every(row => !row.home.actionable));
  assert.ok(preparation.every(row => !row.home.actionLabel.includes('提交')));
  assert.ok(preparation.every(row => row.home.statusLabel.includes('课程筹备中')));
});

test('截止或作业结束后的已有反馈仍排在待评阅记录前，但不抢占开放未交任务', () => {
  const feedback = { state: 'FEEDBACK_AVAILABLE' as const, reviewState: 'PENDING' as const, latestVersionId: 'reviewed', feedbackCount: 1 };
  const ordered = getAssignmentHomeItems([
    item('waiting', { progress: { state: 'SUBMITTED', reviewState: 'PENDING' as const, latestVersionId: 'waiting', feedbackCount: 0 } }),
    item('closed-waiting', { dueAt: new Date('2030-09-20T08:00:00Z'), progress: { state: 'SUBMITTED', reviewState: 'PENDING' as const, latestVersionId: 'closed-waiting', feedbackCount: 0 } }),
    item('ended-feedback', { status: 'ARCHIVED', dueAt: new Date('2030-09-01T08:00:00Z'), progress: feedback }),
    item('late-feedback', { dueAt: new Date('2030-09-30T08:00:00Z'), progress: feedback }),
    item('open-unsubmitted', { dueAt: null }),
  ], options('STUDENT'));
  assert.deepEqual(ordered.map(row => row.id), ['open-unsubmitted', 'ended-feedback', 'late-feedback', 'closed-waiting', 'waiting']);
  for (const row of ordered.slice(1, 3)) {
    assert.equal(row.home.actionable, true);
    assert.equal(row.home.actionLabel, '查看已有反馈');
    assert.match(row.home.statusLabel, /作业已结束|已截止/);
    assert.match(row.home.href, /#version-reviewed$/);
  }
  assert.equal(ordered[3].home.priority, 2);
  assert.equal(ordered[3].home.actionable, false);
});

test('同等优先级依截止、标题和ID稳定排序，纯函数不修改调用方数组', () => {
  const original = [
    item('b', { title: '同名' }),
    item('z', { title: '后续', dueAt: null }),
    item('a', { title: '同名' }),
  ];
  const before = original.map(row => row.id);
  const first = getAssignmentHomeItems(original, options('STUDENT'));
  const second = getAssignmentHomeItems([...original].reverse(), options('STUDENT'));
  assert.deepEqual(first.map(row => row.id), ['a', 'b', 'z']);
  assert.deepEqual(second.map(row => row.id), ['a', 'b', 'z']);
  assert.deepEqual(original.map(row => row.id), before);
  assert.ok(original.every(row => !('home' in row)));
});

test('教师优先处理最新待评阅，即使过截止或作业结束；后续依次为草稿和开放作业', () => {
  const ordered = getAssignmentHomeItems([
    item('open'),
    item('draft', { status: 'DRAFT', dueAt: null }),
    item('past', { dueAt: new Date('2030-09-30T08:00:00Z'), summary: summary(1) }),
    item('ended', { status: 'ARCHIVED', dueAt: new Date('2030-09-01T08:00:00Z'), summary: summary(1) }),
    item('closed-no-pending', { dueAt: new Date('2030-08-01T08:00:00Z') }),
  ], options('TEACHER'));
  assert.deepEqual(ordered.map(row => row.id), ['ended', 'past', 'draft', 'open', 'closed-no-pending']);
  for (const row of ordered.slice(0, 2)) {
    assert.equal(row.home.actionable, true);
    assert.match(row.home.href, /\?view=pending&scope=all$/);
  }
  assert.equal(ordered[2].home.href, '/courses/course/assignments?edit=draft#edit-draft');
});

test('TA只依据负责范围排序和生成待评阅CTA，不把全班待评阅当成个人任务', () => {
  const emptyMine = summary(0, 0);
  const ordered = getAssignmentHomeItems([
    item('all-only', { summary: summary(99, 100), mineSummary: emptyMine }),
    item('mine-done', { mineSummary: { totalExpectedCount: 2, submittedCount: 2, pendingFeedbackCount: 0, feedbackCount: 2, completedReviewCount: 2, unknownReviewCount: 0 } }),
    item('mine-pending', { dueAt: new Date('2030-09-30T08:00:00Z'), summary: summary(99, 100), mineSummary: summary(1, 2) }),
  ], options('TA'));
  assert.deepEqual(ordered.map(row => row.id), ['mine-pending', 'mine-done', 'all-only']);
  assert.match(ordered[0].home.statusLabel, /我负责范围已交 1\/2 人 · 待评阅 1/);
  assert.equal(ordered[0].home.href, '/courses/course/assignments/mine-pending?view=pending&scope=mine');
  assert.ok(ordered.every(row => row.home.href.includes('scope=mine')));
  const noMine = ordered[2].home;
  assert.equal(noMine.actionable, false);
  assert.match(noMine.statusLabel, /负责范围没有应交/);
  assert.doesNotMatch(noMine.statusLabel + noMine.actionLabel, /99|100|待评阅/);
  assert.equal(summaryLabel(summary(1, 2), 'GROUP', 'mine'), '我负责范围已交 1/2 组 · 待评阅 1');
});

test('管理员使用管理语义，不将教师待评阅声明为自己的评阅任务', () => {
  const ordered = getAssignmentHomeItems([
    item('many-pending', { summary: summary(100, 100) }),
    item('draft', { status: 'DRAFT', summary: summary() }),
  ], options('ADMIN'));
  assert.equal(ordered[0].id, 'draft');
  assert.ok(ordered.every(row => row.home.actionLabel === '管理作业'));
  assert.ok(ordered.every(row => !/待评阅|评阅|未读/.test(row.home.statusLabel + row.home.actionLabel)));
  assert.ok(ordered.every(row => row.home.href === `/courses/course/assignments?edit=${row.id}#edit-${row.id}`));
});

test('课程归档对所有身份覆盖待办和写入CTA，只保留阅读入口', () => {
  const assignment = item('archived-course', {
    summary: summary(3, 3), mineSummary: summary(2, 2),
    progress: { state: 'NOT_SUBMITTED', reviewState: null, latestVersionId: null, feedbackCount: 0 },
  });
  for (const audience of ['STUDENT', 'TEACHER', 'TA', 'ADMIN'] as const) {
    const result = getAssignmentHomeItems([assignment], { ...options(audience), offeringStatus: 'ARCHIVED' })[0];
    assert.equal(result.home.actionable, false);
    assert.equal(result.home.actionLabel, '查看记录');
    assert.match(result.home.statusLabel, /只读/);
    assert.doesNotMatch(result.home.href, /view=pending/);
    if (audience === 'TA') assert.match(result.home.href, /scope=mine/);
  }
});

test('生命周期独立说明学生可见性与提交开关，所有管理角色使用相同规则', () => {
  const cases = [
    { assignment: item('draft', { status: 'DRAFT' }), expected: '草稿 · 学生不可见' },
    { assignment: item('published'), expected: '已发布 · 接受提交' },
    { assignment: item('no-deadline', { dueAt: null }), expected: '已发布 · 接受提交' },
    { assignment: item('at-deadline', { dueAt: new Date(now) }), expected: '已截止 · 停止提交，可查看已有反馈' },
    { assignment: item('ended', { status: 'ARCHIVED', dueAt: null }), expected: '已结束 · 停止提交，可查看已有反馈' },
  ];
  for (const audience of ['TEACHER', 'TA', 'ADMIN'] as const) {
    for (const { assignment, expected } of cases) {
      const result = getAssignmentHomeItems([assignment], options(audience))[0];
      assert.equal(result.home.lifecycleLabel, expected, `${audience}: ${assignment.id}`);
    }
  }
});

test('生命周期不把筹备或归档课程说成可提交，也不把归档草稿说成学生可见', () => {
  for (const audience of ['STUDENT', 'TEACHER', 'TA', 'ADMIN'] as const) {
    const preparing = getAssignmentHomeItems([item('published')], { ...options(audience), offeringStatus: 'DRAFT' })[0];
    assert.equal(preparing.home.lifecycleLabel, '已发布 · 课程筹备中，暂不接受提交');
    const archived = getAssignmentHomeItems([item('published')], { ...options(audience), offeringStatus: 'ARCHIVED' })[0];
    assert.equal(archived.home.lifecycleLabel, '课程已归档 · 记录只读');
    const draft = getAssignmentHomeItems([item('draft', { status: 'DRAFT' })], { ...options(audience), offeringStatus: 'ARCHIVED' })[0];
    assert.equal(draft.home.lifecycleLabel, '草稿 · 学生不可见');
  }
});

test('截止生命周期保留助教负责范围及教师待评阅，开放状态也不代替学生分组条件', () => {
  const ended = item('ended', { status: 'ARCHIVED', summary: summary(99, 100), mineSummary: summary(1, 2) });
  const ta = getAssignmentHomeItems([ended], options('TA'))[0].home;
  assert.match(ta.lifecycleLabel, /已结束.*停止提交/);
  assert.equal(ta.statusLabel, '我负责范围已交 1/2 人 · 待评阅 1');
  assert.equal(ta.actionable, true);
  assert.match(ta.href, /view=pending&scope=mine$/);
  const teacher = getAssignmentHomeItems([ended], options('TEACHER'))[0].home;
  assert.equal(teacher.statusLabel, '全班已交 99/100 人 · 待评阅 99');
  assert.equal(teacher.actionable, true);
  const student = getAssignmentHomeItems([item('group', {
    mode: 'GROUP', progress: { state: 'UNGROUPED', reviewState: null, latestVersionId: null, feedbackCount: 0 },
  })], options('STUDENT'))[0].home;
  assert.equal(student.lifecycleLabel, '已发布 · 接受提交');
  assert.match(student.statusLabel, /尚未分组/);
  assert.equal(student.href, '/courses/course/groups');
});

test('取消作业不再催交或分组，已有提交和反馈保留阅读入口', () => {
  const cancelled = item('cancelled', {
    status: 'CANCELLED', mode: 'GROUP', dueAt: new Date('2030-09-01T08:00:00Z'),
    progress: { state: 'CANCELLED', reviewState: 'PENDING' as const, latestVersionId: 'retained-version', feedbackCount: 2 },
    summary: summary(2, 0), mineSummary: summary(1, 0),
  });
  for (const audience of ['STUDENT', 'TEACHER', 'TA', 'ADMIN'] as const) {
    const rows = getAssignmentHomeItems([cancelled, item('open')], options(audience));
    const home = rows.find(row => row.id === 'cancelled')!.home;
    assert.equal(rows.at(-1)!.id, 'cancelled');
    assert.equal(home.lifecycleLabel, '已取消，不再要求完成');
    assert.equal(home.actionable, false);
    assert.doesNotMatch(home.statusLabel + home.actionLabel, /尚未|未分组|未提交|应交|已截止|待评阅|\d+\/0/);
    assert.doesNotMatch(home.href, /#submission|view=pending|\/team$/);
  }
  const student = getAssignmentHomeItems([cancelled], options('STUDENT'))[0].home;
  assert.equal(student.actionLabel, '查看已有反馈');
  assert.match(student.statusLabel, /已有 2 条反馈/);
  assert.match(student.href, /#version-retained-version$/);
  assert.equal(progressLabel(cancelled.progress, 'GROUP'), '已取消，不再要求完成');
});

test('取消状态覆盖旧进度，恢复发布后重新按当前提交条件呈现', () => {
  const assignment = item('cancelled-ungrouped', {
    status: 'CANCELLED', mode: 'GROUP',
    progress: { state: 'UNGROUPED', reviewState: null, latestVersionId: null, feedbackCount: 0 },
  });
  const cancelled = getAssignmentHomeItems([assignment], options('STUDENT'))[0].home;
  assert.equal(cancelled.statusLabel, '已取消，不再要求完成');
  assert.equal(cancelled.actionLabel, '查看记录');
  assert.equal(cancelled.actionable, false);
  const restored = getAssignmentHomeItems([{ ...assignment, status: 'PUBLISHED' as const }], options('STUDENT'))[0].home;
  assert.equal(restored.actionable, true);
  assert.match(restored.statusLabel, /尚未分组/);
  const archived = getAssignmentHomeItems([assignment], { ...options('STUDENT'), offeringStatus: 'ARCHIVED' })[0].home;
  assert.equal(archived.lifecycleLabel, '已取消，不再要求完成');
  assert.equal(archived.actionable, false);
  assert.match(archived.statusLabel, /只读/);
});

test('评阅完成与评论数量分别呈现，没有评论也不能继续声称待评阅', () => {
  assert.equal(progressLabel({ state: 'SUBMITTED', latestVersionId: 'v1', feedbackCount: 0, reviewState: 'COMPLETED' }, 'INDIVIDUAL'), '已提交 · 本轮评阅已完成');
  assert.equal(progressLabel({ state: 'FEEDBACK_AVAILABLE', latestVersionId: 'v1', feedbackCount: 1, reviewState: 'PENDING' }, 'GROUP'), '已有 1 条反馈 · 待评阅');
  const source = item('legacy', {
    summary: { totalExpectedCount: 1, submittedCount: 1, feedbackCount: 1, pendingFeedbackCount: 0, completedReviewCount: 0, unknownReviewCount: 1 },
  });
  const result = getAssignmentHomeItems([source], { audience: 'TEACHER', offeringStatus: 'ACTIVE', now })[0];
  assert.equal(result.home.actionable, false);
  assert.match(result.home.statusLabel, /历史待核对 1/);
  assert.doesNotMatch(result.home.actionLabel, /待评阅/);
});
