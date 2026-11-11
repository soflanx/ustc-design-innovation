import type { FormState } from './form-state';

/** Values the student explicitly checked before sending this request. */
export type SubmissionConfirmation = {
  assignmentRevision: number;
  latestSubmissionToken: string;
  groupId: string | null;
};

export type SubmissionRequirements = {
  revision: number;
  title: string;
  description: string;
  descriptionParts?: { text: string; href?: string }[];
  mode: 'INDIVIDUAL' | 'GROUP';
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'CANCELLED';
  dueAt: string | null;
  maxScore: number;
  cancellationReason: string | null;
};

export type SubmissionAttachment = { id: string; name: string; size: number };
export type SubmissionUpload = { name: string; bytes: Uint8Array };
export const MAX_SUBMISSION_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_SUBMISSION_FILES = 20;

/** Only populated when the current student is allowed to read that version. */
export type SubmissionLatestVersion = {
  id: string;
  version: number;
  body: string;
  submittedAt: string;
  submittedByName: string;
  attachments?: SubmissionAttachment[];
};

export type SubmissionContext = {
  confirmation: SubmissionConfirmation;
  requirements: SubmissionRequirements;
  latestSubmission: SubmissionLatestVersion | null;
  groupName: string | null;
  canSubmit: boolean;
  blockedReason: string | null;
  correctionUntil?: string | null;
};

export type SubmissionConflictReason = 'requirements' | 'latest_submission' | 'group';

export type SubmissionFormState = FormState & {
  identityBlocked?: true;
  conflict?: {
    reasons: SubmissionConflictReason[];
    context: SubmissionContext;
  };
  receipt?: {
    id: string;
    version: number;
    submittedAt: string;
    assignmentRevision: number | null;
  };
};

export type SubmissionInput = {
  body: string;
  requestId: string;
  expectedAssignmentRevision: number;
  expectedLatestSubmissionToken: string;
  expectedGroupId: string | null;
  uploads?: SubmissionUpload[];
  retainedFileIds?: string[];
};
