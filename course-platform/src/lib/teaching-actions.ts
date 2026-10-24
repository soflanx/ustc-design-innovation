'use server';

import { z } from 'zod';
import type { FormState } from './form-state';
import { DomainError } from './management';
import { refreshTeaching, runCourseAction } from './action-utils';
import { parseTeachingDateInput } from './teaching-format';
import { addFeedback, createAssignment, submitAssignment, updateAssignment, type AssignmentInput } from './teaching';

function assignmentValues(form: FormData): AssignmentInput {
  let dueAt: Date | null;
  try { dueAt = parseTeachingDateInput(String(form.get('dueAt') ?? '')); }
  catch { throw new DomainError('请填写有效的截止时间（北京时间）。'); }
  return {
    title: String(form.get('title') ?? ''),
    description: String(form.get('description') ?? ''),
    mode: z.enum(['INDIVIDUAL', 'GROUP']).parse(form.get('mode')),
    status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).parse(form.get('status')),
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

export async function updateAssignmentAction(offeringId: string, assignmentId: string, _state: FormState, form: FormData): Promise<FormState> {
  return runCourseAction(async userId => {
    await updateAssignment(userId, offeringId, assignmentId, assignmentValues(form));
    refreshTeaching(offeringId);
    return { success: '作业已保存。' };
  });
}

export async function submitAssignmentAction(offeringId: string, assignmentId: string, _state: FormState, form: FormData): Promise<FormState> {
  return runCourseAction(async userId => {
    const version = await submitAssignment(userId, offeringId, assignmentId, {
      body: String(form.get('body') ?? ''),
      requestId: String(form.get('requestId') ?? ''),
      expectedGroupId: String(form.get('expectedGroupId') ?? '') || null,
    });
    refreshTeaching(offeringId);
    return { success: `第 ${version.version} 版已提交并保存。` };
  });
}

export async function addFeedbackAction(offeringId: string, versionId: string, _state: FormState, form: FormData): Promise<FormState> {
  return runCourseAction(async userId => {
    await addFeedback(userId, offeringId, versionId, String(form.get('body') ?? ''));
    refreshTeaching(offeringId);
    return { success: '反馈已发布，参与本次提交的学生可以查看。' };
  });
}
