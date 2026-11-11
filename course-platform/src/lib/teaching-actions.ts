'use server';

import { z } from 'zod';
import type { FormState } from './form-state';
import { MAX_SUBMISSION_FILE_BYTES, MAX_SUBMISSION_FILES, type SubmissionFormState } from './submission-contract';
import { readResourceUpload } from './resource-file';
import { DomainError } from './management';
import { refreshTeaching, runCourseAction } from './action-utils';
import { parseTeachingDateInput } from './teaching-format';
import { addFeedback, AssignmentRevisionConflictError, createAssignment, submitAssignment, SubmissionConflictError, ReviewRevisionConflictError, setSubmissionCorrectionWindow, setSubmissionReviewState, updateAssignment, type AssignmentInput } from './teaching';

function assignmentValues(form: FormData): AssignmentInput {
  let dueAt: Date | null;
  try { dueAt = parseTeachingDateInput(String(form.get('dueAt') ?? '')); }
  catch { throw new DomainError('请填写有效的截止时间（北京时间）。'); }
  return {
    title: String(form.get('title') ?? ''),
    description: String(form.get('description') ?? ''),
    mode: z.enum(['INDIVIDUAL', 'GROUP']).parse(form.get('mode')),
    status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED', 'CANCELLED']).parse(form.get('status')),
    cancellationReason: String(form.get('cancellationReason') ?? ''),
    maxScore: form.get('maxScore') === null || form.get('maxScore') === '' ? undefined : Number(form.get('maxScore')),
    dueAt,
  };
}

export async function createAssignmentAction(offeringId: string, _state: FormState, form: FormData): Promise<FormState> {
  return runCourseAction(async userId => {
    const assignment = await createAssignment(userId, offeringId, assignmentValues(form));
    refreshTeaching(offeringId);
    return { redirectTo: `/courses/${offeringId}/assignments/${assignment.id}` };
  });
}

export type AssignmentEditState = FormState & { revisionConflict?: true };

export async function updateAssignmentAction(offeringId: string, assignmentId: string, expectedUserId: string, _state: FormState, form: FormData): Promise<AssignmentEditState> {
  return runCourseAction(async (userId): Promise<AssignmentEditState> => {
    if (typeof expectedUserId !== 'string' || !expectedUserId) return { error: '这张表单缺少账号信息，请用原账号重新打开作业编辑器。' };
    if (expectedUserId !== userId) return { error: '登录账号已切换，请切回打开作业编辑器时的账号。当前修改已保留，尚未保存。' };
    try {
      await updateAssignment(userId, offeringId, assignmentId, assignmentValues(form), Number(form.get('expectedRevision')));
    } catch (error) {
      if (error instanceof AssignmentRevisionConflictError) return {
        revisionConflict: true,
        error: '作业已有更新。此页保留了你的输入。请对照最新版，将需要保留的修改复制过去。',
      };
      throw error;
    }
    refreshTeaching(offeringId);
    return { success: '作业已保存。' };
  }, '登录已过期，请在另一个标签页登录原账号，再回此页保存。当前修改已保留。');
}

const signedOutSubmission: SubmissionFormState = {
  identityBlocked: true, error: '登录已过期。请在另一个标签页登录原学生账号，再回此页提交。',
};

export async function submitAssignmentAction(offeringId: string, assignmentId: string, expectedUserId: string, _state: SubmissionFormState, form: FormData): Promise<SubmissionFormState> {
  return runCourseAction(async (userId): Promise<SubmissionFormState> => {
    if (typeof expectedUserId !== 'string' || !expectedUserId) return {
      identityBlocked: true, error: '这张表单缺少账号信息，请用原学生账号重新打开作业。',
    };
    if (expectedUserId !== userId) return {
      identityBlocked: true, error: '当前登录账号与打开作业时不同。请在另一个标签页切回原学生账号，再回此页提交。',
    };
    try {
      const attachments = form.getAll('attachments');
      const retained = form.getAll('retainedFileIds');
      if (attachments.length + retained.length > MAX_SUBMISSION_FILES
        || attachments.some(file => typeof file === 'string') || retained.some(id => typeof id !== 'string')) {
        throw new DomainError('提交附件无效或超过数量上限。');
      }
      const files = (attachments as File[]).filter(file => file.name || file.size);
      if (files.reduce((total, file) => total + file.size, 0) > MAX_SUBMISSION_FILE_BYTES) throw new DomainError('附件合计不能超过 10 MiB。');
      const uploads = [];
      for (const file of files) {
        const upload = await readResourceUpload(file);
        if (upload) uploads.push(upload);
      }
      const version = await submitAssignment(userId, offeringId, assignmentId, {
        body: String(form.get('body') ?? ''), uploads, retainedFileIds: retained as string[],
        requestId: String(form.get('requestId') ?? ''),
        expectedGroupId: String(form.get('expectedGroupId') ?? '') || null,
        expectedAssignmentRevision: Number(form.get('expectedAssignmentRevision')),
        expectedLatestSubmissionToken: String(form.get('expectedLatestSubmissionToken') ?? ''),
      });
      refreshTeaching(offeringId);
      return { success: version.version === 1 ? '正式成果已提交。' : '正式成果已更正。', receipt: {
        id: version.id, version: version.version, submittedAt: version.submittedAt.toISOString(),
        assignmentRevision: version.assignmentRevision?.revision ?? null,
      } };
    } catch (error) {
      if (error instanceof SubmissionConflictError) return {
        error: error.message, conflict: { reasons: error.reasons, context: error.submissionContext },
      };
      throw error;
    }
  }, signedOutSubmission);
}

const signedOutReviewMessage = '登录已过期。请在另一个标签页登录原评阅账号，再回此页继续。';

function requireOriginalReviewer(userId: string, form: FormData) {
  if (form.get('expectedUserId') !== userId) throw new DomainError('当前登录账号与打开评阅页时不同。请在另一个标签页切回原评阅账号，再回此页继续。');
}

export async function addFeedbackAction(offeringId: string, versionId: string, _state: FormState, form: FormData): Promise<FormState> {
  return runCourseAction(async userId => {
    requireOriginalReviewer(userId, form);
    await addFeedback(userId, offeringId, versionId, String(form.get('body') ?? ''));
    refreshTeaching(offeringId);
    return { success: '评语已保存，学生可在这份作品下查看。' };
  }, signedOutReviewMessage);
}

export type ReviewStateResult = FormState & { revisionConflict?: true };

export async function setSubmissionReviewStateAction(offeringId: string, versionId: string, _state: FormState, form: FormData): Promise<ReviewStateResult> {
  return runCourseAction(async (userId): Promise<ReviewStateResult> => {
    requireOriginalReviewer(userId, form);
    const state = z.enum(['PENDING', 'COMPLETED']).parse(form.get('state'));
    const revision = form.get('expectedRevision');
    try {
      await setSubmissionReviewState(userId, offeringId, versionId, {
        state, expectedRevision: typeof revision === 'string' && /^(0|[1-9]\d*)$/.test(revision) ? Number(revision) : -1,
      });
    } catch (error) {
      if (error instanceof ReviewRevisionConflictError) return { error: error.message, revisionConflict: true };
      throw error;
    }
    refreshTeaching(offeringId);
    return { success: state === 'COMPLETED' ? '此提交版本已标记为评阅完成。' : '此提交版本已重新进入待评阅。' };
  }, signedOutReviewMessage);
}

export async function setSubmissionCorrectionWindowAction(offeringId: string, assignmentId: string, submissionId: string, _state: FormState, form: FormData): Promise<FormState> {
  return runCourseAction(async userId => {
    requireOriginalReviewer(userId, form);
    const operation = form.get('operation');
    if (operation !== 'open' && operation !== 'revoke') throw new DomainError('请选择开放或撤销更正。');
    let until: Date | null = null;
    if (operation === 'open') {
      try { until = parseTeachingDateInput(String(form.get('until') ?? '')); }
      catch { throw new DomainError('请填写有效的更正期限（北京时间）。'); }
      if (!until) throw new DomainError('请填写更正期限。');
    }
    const revision = form.get('expectedRevision');
    if (typeof revision !== 'string' || !/^\d+$/.test(revision)) throw new DomainError('更正记录缺少修订号，请刷新后重试。');
    await setSubmissionCorrectionWindow(userId, offeringId, assignmentId, submissionId, Number(revision), until);
    refreshTeaching(offeringId);
    return { success: until ? '已为该成果开放更正。' : '已撤销该成果的更正权限。' };
  }, signedOutReviewMessage);
}
