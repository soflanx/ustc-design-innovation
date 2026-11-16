import { MAX_SUBMISSION_FILES, type SubmissionConfirmation, type SubmissionConflictReason, type SubmissionContext } from './submission-contract';

/** Only the student's own draft and comparison values are persisted locally. */
export type SubmissionDraft = {
  body: string;
  requestId: string;
  confirmation: SubmissionConfirmation | null;
  expectedGroupId: string | null;
  pendingAttempt: boolean;
  uploadNames?: string[];
  uploadingFileIds?: string[];
  stagedFileIds?: string[];
  retainedFileIds?: string[];
  retainedFromVersionId?: string;
};

export type SubmissionReviewReason = SubmissionConflictReason | 'unconfirmed';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const uploadUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function isSubmissionUploadId(value: unknown): value is string {
  return typeof value === 'string' && uploadUuid.test(value);
}

function uploadIdsFrom(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > MAX_SUBMISSION_FILES || !value.every(isSubmissionUploadId)) return;
  const ids = value.map(id => id.toLowerCase());
  if (new Set(ids).size === ids.length) return ids;
}

function confirmationFrom(value: unknown): SubmissionConfirmation | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<SubmissionConfirmation>;
  if (!Number.isInteger(item.assignmentRevision) || item.assignmentRevision! < 1
    || typeof item.latestSubmissionToken !== 'string' || !/^[a-f0-9]{64}$/.test(item.latestSubmissionToken)
    || !(item.groupId === null || (typeof item.groupId === 'string' && item.groupId.length > 0 && item.groupId.length <= 150))) return null;
  return { assignmentRevision: item.assignmentRevision!, latestSubmissionToken: item.latestSubmissionToken, groupId: item.groupId };
}

export function newSubmissionDraft(requestId: string, context: SubmissionContext): SubmissionDraft {
  return { body: '', requestId, confirmation: { ...context.confirmation }, expectedGroupId: context.confirmation.groupId, pendingAttempt: false };
}

function hasDraftContent(draft: SubmissionDraft) {
  return Boolean(draft.body || draft.pendingAttempt || draft.uploadNames?.length || draft.retainedFileIds);
}

/** Only write when the browser still holds the draft this editor last read or saved. */
export function writeStoredSubmissionDraft(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  key: string,
  expected: string | null,
  draft: SubmissionDraft | null,
): string | null | undefined {
  if (storage.getItem(key) !== expected) return undefined;
  const saved = draft && hasDraftContent(draft) ? JSON.stringify(draft) : null;
  if (saved !== expected) {
    if (saved === null) storage.removeItem(key);
    else storage.setItem(key, saved);
  }
  return saved;
}

/** A legacy or malformed confirmation never inherits the freshly rendered context. */
export function restoreSubmissionDraft(raw: string, fallbackRequestId: string): SubmissionDraft {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !('body' in value) || typeof value.body !== 'string' || value.body.length > 12000) throw new Error('INVALID_DRAFT');
  const saved = value as Record<string, unknown>;
  const confirmation = confirmationFrom(saved.confirmation);
  const validRequestId = typeof saved.requestId === 'string' && uuid.test(saved.requestId);
  const uploadNames = Array.isArray(saved.uploadNames) && saved.uploadNames.length <= MAX_SUBMISSION_FILES
    && saved.uploadNames.every(name => typeof name === 'string' && name.length <= 255) ? saved.uploadNames as string[] : undefined;
  const completeIds = uploadIdsFrom(saved.stagedFileIds);
  const stagedFileIds = confirmation && validRequestId && completeIds && completeIds.length === uploadNames?.length ? completeIds : undefined;
  const partialIds = uploadIdsFrom(saved.uploadingFileIds);
  const uploadingFileIds = !stagedFileIds && uploadNames && partialIds && partialIds.length <= uploadNames.length ? partialIds : undefined;
  return {
    body: value.body,
    requestId: validRequestId ? saved.requestId as string : fallbackRequestId,
    confirmation,
    expectedGroupId: confirmation ? confirmation.groupId : typeof saved.expectedGroupId === 'string' ? saved.expectedGroupId : null,
    // An uncertain attempt can only be retried with its original complete values.
    pendingAttempt: saved.pendingAttempt === true && confirmation !== null && validRequestId,
    ...(uploadNames ? { uploadNames } : {}),
    ...(uploadingFileIds ? { uploadingFileIds } : {}),
    ...(stagedFileIds ? { stagedFileIds } : {}),
    ...(Array.isArray(saved.retainedFileIds) && saved.retainedFileIds.length <= 20 && saved.retainedFileIds.every(id => typeof id === 'string' && id.length <= 200)
      ? { retainedFileIds: saved.retainedFileIds as string[] } : {}),
    ...(typeof saved.retainedFromVersionId === 'string' && saved.retainedFromVersionId.length <= 200
      ? { retainedFromVersionId: saved.retainedFromVersionId } : {}),
  };
}

export function submissionReviewReasons(draft: SubmissionDraft, context: SubmissionContext): SubmissionReviewReason[] {
  const previous = draft.confirmation;
  if (!previous) return ['unconfirmed'];
  const reasons: SubmissionReviewReason[] = [];
  if (previous.assignmentRevision !== context.confirmation.assignmentRevision) reasons.push('requirements');
  if (previous.groupId !== context.confirmation.groupId) reasons.push('group');
  if (previous.latestSubmissionToken !== context.confirmation.latestSubmissionToken) reasons.push('latest_submission');
  return reasons;
}

/** A revision may start only from the readable latest version of the current owner. */
export function revisionDraftAction(draft: SubmissionDraft, context: SubmissionContext, versionId: string, storageReadable: boolean) {
  if (!context.canSubmit || context.latestSubmission?.id !== versionId) return null;
  if (hasDraftContent(draft) || submissionReviewReasons(draft, context).length) return 'continue';
  return storageReadable ? 'seed' : 'open';
}

/** Confirmation changes the checked context, never the draft body or operation identity. */
export function confirmSubmissionDraft(draft: SubmissionDraft, context: SubmissionContext): SubmissionDraft {
  const confirmed = { ...draft, confirmation: { ...context.confirmation }, expectedGroupId: context.confirmation.groupId, pendingAttempt: false };
  if (draft.expectedGroupId !== context.confirmation.groupId || draft.retainedFromVersionId !== context.latestSubmission?.id) {
    delete confirmed.retainedFileIds;
    delete confirmed.retainedFromVersionId;
  }
  return confirmed;
}

export function editSubmissionDraft(draft: SubmissionDraft, body: string, nextRequestId: string): SubmissionDraft {
  if (body === draft.body) return draft;
  return { ...draft, body, requestId: nextRequestId, pendingAttempt: false };
}

export function draftAfterRejectedSubmission(beforeAttempt: SubmissionDraft, reason: 'identityBlocked' | 'conflict'): SubmissionDraft {
  // A confirmation conflict follows the server's idempotency check. An identity
  // refusal happens before that check, so an earlier unanswered request stays pending.
  if (reason === 'conflict' && beforeAttempt.pendingAttempt) return { ...beforeAttempt, pendingAttempt: false };
  return beforeAttempt;
}
