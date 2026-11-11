import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SubmissionContext } from '../src/lib/submission-contract';
import { confirmSubmissionDraft, draftAfterRejectedSubmission, editSubmissionDraft, newSubmissionDraft, restoreSubmissionDraft, revisionDraftAction, submissionReviewReasons } from '../src/lib/submission-draft';

const requestId = '00000000-0000-4000-8000-000000000001';
const nextRequestId = '00000000-0000-4000-8000-000000000002';
const context = (revision = 2, token = 'a', groupId: string | null = 'group-a'): SubmissionContext => ({
  confirmation: { assignmentRevision: revision, latestSubmissionToken: token.repeat(64), groupId },
  requirements: { revision, title: '观察记录', description: '访谈三人。', mode: groupId ? 'GROUP' : 'INDIVIDUAL', status: 'PUBLISHED', dueAt: null, maxScore: 100, cancellationReason: null },
  latestSubmission: null, groupName: groupId, canSubmit: true, blockedReason: null,
});

test('从版本反馈起草只使用当前归属仍可读取的最新版，已有草稿或未确认请求优先', () => {
  const first = { id: 'v1', version: 1, body: '原观察', submittedAt: '2030-10-05T01:00:00Z', submittedByName: '学生 A' };
  const live = { ...context(), latestSubmission: first };
  const blank = newSubmissionDraft(requestId, live);
  assert.equal(revisionDraftAction(blank, live, first.id, true), 'seed');
  assert.equal(revisionDraftAction(blank, live, first.id, false), 'open');
  const edited = editSubmissionDraft(blank, '我已经改了一半', nextRequestId);
  assert.equal(revisionDraftAction(edited, live, first.id, true), 'continue');
  assert.equal(revisionDraftAction({ ...blank, pendingAttempt: true }, live, first.id, true), 'continue');
  assert.equal(revisionDraftAction({ ...blank, confirmation: null }, live, first.id, true), 'continue');
  assert.equal(revisionDraftAction(blank, { ...context(3), latestSubmission: first }, first.id, true), 'continue');
  assert.equal(revisionDraftAction(blank, { ...live, canSubmit: false }, first.id, true), null);
  assert.equal(revisionDraftAction(blank, { ...live, latestSubmission: { ...first, id: 'v2', version: 2 } }, first.id, true), null);
  assert.equal(revisionDraftAction(edited, context(2, 'b', 'group-b'), first.id, true), null);
  assert.equal(edited.body, '我已经改了一半');
  assert.equal(edited.requestId, nextRequestId);
});

test('账号校验拒绝时首次提交仍是普通草稿，先前结果未确认的提交保留原请求以便重试', () => {
  const draft = { ...newSubmissionDraft(requestId, context()), body: '学生 A 的私有正文' };
  for (const pendingAttempt of [false, true]) {
    const beforeAttempt = { ...draft, pendingAttempt };
    const retained = draftAfterRejectedSubmission(beforeAttempt, 'identityBlocked');
    assert.equal(retained.body, draft.body);
    assert.equal(retained.requestId, requestId);
    assert.deepEqual(retained.confirmation, context().confirmation);
    assert.equal(retained.expectedGroupId, 'group-a');
    assert.equal(retained.pendingAttempt, pendingAttempt);
  }
  const retry = { ...draft, pendingAttempt: true };
  assert.deepEqual(draftAfterRejectedSubmission(retry, 'conflict'), draft);
  assert.equal(retry.pendingAttempt, true);
});

test('恢复草稿保留原要求、最新提交和归属，页面更新不会替它接受新上下文', () => {
  const original = { ...newSubmissionDraft(requestId, context()), body: '按原要求写到一半' };
  const draft = restoreSubmissionDraft(JSON.stringify(original), nextRequestId);
  assert.deepEqual(draft, original);
  assert.deepEqual(submissionReviewReasons(draft, context()), []);
  assert.deepEqual(submissionReviewReasons(draft, context(3, 'b', 'group-b')), ['requirements', 'group', 'latest_submission']);
  assert.deepEqual(draft.confirmation, context().confirmation);
  assert.equal(draft.requestId, requestId);
});

test('旧格式或无效确认保留正文与请求标识，必须重新核对；不继承当前页版本', () => {
  for (const confirmation of [undefined, { assignmentRevision: 0, latestSubmissionToken: 'x', groupId: null }]) {
    const draft = restoreSubmissionDraft(JSON.stringify({ body: '旧草稿', requestId, expectedGroupId: 'group-old', confirmation, pendingAttempt: true }), nextRequestId);
    assert.equal(draft.body, '旧草稿');
    assert.equal(draft.requestId, requestId);
    assert.equal(draft.expectedGroupId, 'group-old');
    assert.equal(draft.confirmation, null);
    assert.equal(draft.pendingAttempt, false);
    assert.deepEqual(submissionReviewReasons(draft, context()), ['unconfirmed']);
  }
});

test('确认只接受展示的具体上下文并保留正文和请求号，再次变化必须再次核对', () => {
  const original = { ...newSubmissionDraft(requestId, context()), body: '不要丢掉正文' };
  const accepted = confirmSubmissionDraft(original, context(3, 'b'));
  assert.equal(accepted.body, original.body);
  assert.equal(accepted.requestId, requestId);
  assert.deepEqual(submissionReviewReasons(accepted, context(3, 'b')), []);
  assert.deepEqual(submissionReviewReasons(accepted, context(4, 'b')), ['requirements']);
  assert.deepEqual(submissionReviewReasons(accepted, context(3, 'c')), ['latest_submission']);
  assert.deepEqual(original.confirmation, context().confirmation);
});

test('结果未确认的提交恢复相同请求与上下文，改正文才开启新请求', () => {
  const attempt = { ...newSubmissionDraft(requestId, context()), body: '已点击提交但未收到结果', pendingAttempt: true };
  const restored = restoreSubmissionDraft(JSON.stringify(attempt), nextRequestId);
  assert.deepEqual(restored, attempt);
  assert.equal(editSubmissionDraft(restored, restored.body, nextRequestId), restored);
  const edited = editSubmissionDraft(restored, '明确修改后的正文', nextRequestId);
  assert.equal(edited.requestId, nextRequestId);
  assert.equal(edited.pendingAttempt, false);
  assert.deepEqual(edited.confirmation, restored.confirmation);
});

test('无权读取的最新提交仍能通过不透明标识发现变化，不需要旧版正文', () => {
  const draft = newSubmissionDraft(requestId, context());
  const changed = context(2, 'b');
  assert.equal(changed.latestSubmission, null);
  assert.deepEqual(submissionReviewReasons(draft, changed), ['latest_submission']);
  const stored = JSON.stringify(confirmSubmissionDraft({ ...draft, body: '我的正文' }, changed));
  assert.equal(stored.includes('requirements'), false);
  assert.equal(stored.includes('latestSubmission"'), false);
});

test('异常草稿不猜测内容，损坏请求标识不能恢复为可重试的旧操作', () => {
  for (const raw of ['{', 'null', JSON.stringify({ body: '字'.repeat(12001) })]) assert.throws(() => restoreSubmissionDraft(raw, requestId));
  const draft = restoreSubmissionDraft(JSON.stringify({ ...newSubmissionDraft('broken', context()), body: '仍保留正文', pendingAttempt: true }), nextRequestId);
  assert.equal(draft.body, '仍保留正文');
  assert.equal(draft.requestId, nextRequestId);
  assert.equal(draft.pendingAttempt, false);
  const individual = restoreSubmissionDraft(JSON.stringify({ ...newSubmissionDraft(requestId, context(2, 'a', null)), body: '个人作业', expectedGroupId: 'stale-group' }), nextRequestId);
  assert.equal(individual.expectedGroupId, null);
});

test('同一归属和成果重新核对时保留附件取舍，调组或成果变动时重新选择', () => {
  const latestSubmission = { id: 'v1', version: 1, body: '', submittedAt: '2030-10-05T01:00:00Z', submittedByName: '学生 A' };
  const initial = { ...context(), latestSubmission };
  const draft = { ...newSubmissionDraft(requestId, initial), retainedFileIds: [], retainedFromVersionId: latestSubmission.id };
  const restored = restoreSubmissionDraft(JSON.stringify(draft), requestId);
  assert.deepEqual(confirmSubmissionDraft(restored, { ...context(3, 'b'), latestSubmission }).retainedFileIds, []);
  assert.equal(confirmSubmissionDraft(restored, { ...context(2, 'b'), latestSubmission: { ...latestSubmission, id: 'v2' } }).retainedFileIds, undefined);
  assert.equal(confirmSubmissionDraft(restored, { ...context(2, 'b', 'group-b'), latestSubmission }).retainedFileIds, undefined);
});
