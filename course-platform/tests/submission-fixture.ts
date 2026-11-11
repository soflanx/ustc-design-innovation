import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getAssignmentDetail } from '../src/lib/teaching';
import type { SubmissionInput } from '../src/lib/submission-contract';

/** A fixture models the student reading and confirming the current page. */
export async function confirmedSubmissionInput(userId: string, offeringId: string, assignmentId: string, body = '本周的观察记录', expectedGroupId?: string | null): Promise<SubmissionInput> {
  const detail = await getAssignmentDetail(userId, offeringId, assignmentId);
  assert.ok(detail.submissionContext, 'Only an authorized student can confirm a submission');
  const { confirmation } = detail.submissionContext;
  return {
    body, requestId: randomUUID(), expectedAssignmentRevision: confirmation.assignmentRevision,
    expectedLatestSubmissionToken: confirmation.latestSubmissionToken,
    expectedGroupId: expectedGroupId === undefined ? confirmation.groupId : expectedGroupId,
  };
}
