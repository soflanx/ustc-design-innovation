import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssignmentReviewQueueItem } from '../src/lib/teaching';
import { getAssignmentStatistics } from '../src/lib/teaching-presentation';

const cutoff = new Date('2026-11-08T15:59:00Z');
const assignment = { mode: 'INDIVIDUAL', status: 'PUBLISHED', dueAt: cutoff } as const;

function owner(id: string, data: Partial<AssignmentReviewQueueItem> = {}): AssignmentReviewQueueItem {
  return {
    id, ownerLabel: id, groupId: null, latestVersionId: null, latestVersionNumber: null, submittedAt: null,
    feedbackCount: 0, reviewState: null, reviewRevision: null, assignedToMe: false,
    submissionId: null, correctionUntil: null, correctionRevision: 0, ...data,
  };
}

const ids = (rows: AssignmentReviewQueueItem[]) => rows.map(row => row.id);

test('助教分别查看负责、全班和未分组个人的当前提交与评阅名单', () => {
  const queue = [
    owner('A', { groupId: '另一组', latestVersionId: 'A-v2', reviewState: 'COMPLETED' }),
    owner('B', { groupId: '另一组' }),
    owner('C', { latestVersionId: 'C-v1', reviewState: 'PENDING', feedbackCount: 2 }),
    owner('D'),
    owner('E', { groupId: '负责组', assignedToMe: true }),
  ];
  const context = { offeringStatus: 'ACTIVE', now: cutoff } as const;
  const mine = getAssignmentStatistics(assignment, queue, { ...context, scope: 'mine' });
  assert.equal(mine.ownerCount, 1);
  assert.equal(mine.unassignedCount, 2);
  assert.deepEqual(ids(mine.rows.latest), []);
  assert.deepEqual(ids(mine.rows.missing), ['E']);

  const all = getAssignmentStatistics(assignment, queue, { ...context, scope: 'all' });
  assert.equal(all.ownerCount, 5);
  assert.deepEqual(ids(all.rows.latest), ['A', 'C']);
  assert.deepEqual(ids(all.rows.completed), ['A']);
  assert.deepEqual(ids(all.rows.pending), ['C']);
  assert.deepEqual(ids(all.rows.missing), ['B', 'D', 'E']);

  const unassigned = getAssignmentStatistics(assignment, queue, { ...context, scope: 'unassigned' });
  assert.equal(unassigned.ownerCount, 2);
  assert.equal(unassigned.missingLabel, '逾期未交');
  assert.deepEqual(ids(unassigned.rows.latest), ['C']);
  assert.deepEqual(ids(unassigned.rows.pending), ['C']);
  assert.deepEqual(ids(unassigned.rows.missing), ['D']);
});

test('未交在截止到点时成为逾期，取消和未开放的作业没有应交名单', () => {
  const queue = [owner('已有', { latestVersionId: 'legacy', reviewState: 'LEGACY_UNKNOWN', feedbackCount: 1 }), owner('未交')];
  const context = { scope: 'all', offeringStatus: 'ACTIVE', now: cutoff } as const;
  assert.equal(getAssignmentStatistics(assignment, queue, { ...context, now: new Date(cutoff.getTime() - 1) }).missingLabel, '未交');
  assert.equal(getAssignmentStatistics(assignment, queue, context).missingLabel, '逾期未交');
  assert.equal(getAssignmentStatistics({ ...assignment, dueAt: null }, queue, context).missingLabel, '未交');
  assert.equal(getAssignmentStatistics(assignment, queue, { ...context, offeringStatus: 'ARCHIVED' }).missingLabel, '未交');

  const cancelled = getAssignmentStatistics({ ...assignment, status: 'CANCELLED' }, queue, context);
  assert.equal(cancelled.ownerCount, null);
  assert.equal(cancelled.missingLabel, null);
  assert.equal(cancelled.unassignedCount, 1);
  assert.deepEqual(ids(cancelled.rows.latest), ['已有']);
  assert.deepEqual(ids(cancelled.rows.unconfirmed), ['已有']);
  assert.deepEqual(ids(cancelled.rows.pending), []);
  assert.deepEqual(ids(cancelled.rows.completed), []);
  assert.deepEqual(ids(cancelled.rows.missing), []);
  assert.equal(getAssignmentStatistics({ ...assignment, status: 'DRAFT' }, [owner('学生')], context).ownerCount, null);
  assert.equal(getAssignmentStatistics(assignment, [owner('学生')], { ...context, offeringStatus: 'DRAFT' }).missingLabel, null);
});

test('小组作业的统计以小组为归属，不生成未分组学生的队列', () => {
  const queue = [owner('一组', { groupId: '一组', assignedToMe: true, latestVersionId: 'group-v1', reviewState: 'PENDING' }), owner('二组', { groupId: '二组' })];
  const statistics = getAssignmentStatistics({ ...assignment, mode: 'GROUP' }, queue, { scope: 'all', offeringStatus: 'ACTIVE', now: cutoff });
  assert.equal(statistics.ownerCount, 2);
  assert.equal(statistics.unassignedCount, 0);
  assert.deepEqual(ids(statistics.rows.latest), ['一组']);
  assert.deepEqual(ids(statistics.rows.missing), ['二组']);
});
