'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { refreshTeaching, requireEditorAuthor, runCourseAction } from './action-utils';
import type { FormState } from './form-state';
import { createStudentGroup, joinStudentGroup, setGroupFormation, updateGroupRecruitment } from './group-formation';
import { groupWorkHref } from './group-work-link';
import { DomainError } from './management';
import { parseTeachingDateInput } from './teaching-format';

function textField(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function saveGroupFormationAction(offeringId: string, expectedUserId: string, expectedOpenWindowId: string | null, _state: FormState, form: FormData): Promise<FormState> {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    let closesAt: Date | null;
    try { closesAt = parseTeachingDateInput(textField(form, 'closesAt')); }
    catch { throw new DomainError('请填写有效的组队截止时间（北京时间）。'); }
    if (!closesAt) throw new DomainError('请填写组队截止时间（北京时间）。');
    await setGroupFormation(userId, offeringId, { capacity: Number(textField(form, 'capacity')), closesAt }, expectedOpenWindowId);
    refreshTeaching(offeringId);
    return { success: '组队设置已保存。' };
  });
}

export async function closeGroupFormationAction(offeringId: string, expectedUserId: string, expectedOpenWindowId: string | null, _state: FormState, _form: FormData): Promise<FormState> {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    await setGroupFormation(userId, offeringId, null, expectedOpenWindowId);
    refreshTeaching(offeringId);
    return { success: '本期自助组队已结束。' };
  });
}

export async function createStudentGroupAction(offeringId: string, expectedUserId: string, windowId: string, requestId: string, sourcePageId: string | undefined, _state: FormState, form: FormData): Promise<FormState> {
  const state = await runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    const result = await createStudentGroup(userId, offeringId, {
      name: textField(form, 'name'), note: textField(form, 'note'),
      mode: z.enum(['COURSE', 'INVITE'], { error: '请选择招募方式。' }).parse(form.get('mode')),
      windowId, requestId,
    });
    refreshTeaching(offeringId);
    return { redirectTo: groupWorkHref(offeringId, sourcePageId, result.groupId ?? undefined) };
  });
  if (state.redirectTo) redirect(state.redirectTo);
  return state;
}

export async function joinStudentGroupAction(offeringId: string, expectedUserId: string, windowId: string, requestId: string, target: { groupId: string } | { inviteToken: string }, sourcePageId: string | undefined, _state: FormState, _form: FormData): Promise<FormState> {
  const state = await runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    const result = await joinStudentGroup(userId, offeringId, { ...target, windowId, requestId });
    refreshTeaching(offeringId);
    return { redirectTo: groupWorkHref(offeringId, sourcePageId, result.groupId ?? undefined) };
  });
  if (state.redirectTo) redirect(state.redirectTo);
  return state;
}

export async function updateGroupRecruitmentAction(offeringId: string, expectedUserId: string, groupId: string, windowId: string, _state: FormState, form: FormData): Promise<FormState> {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    await updateGroupRecruitment(userId, offeringId, groupId, {
      mode: z.enum(['COURSE', 'INVITE', 'CLOSED'], { error: '请选择招募方式。' }).parse(form.get('mode')),
      note: textField(form, 'note'), windowId,
    });
    refreshTeaching(offeringId);
    return { success: '本组招募设置已保存。' };
  });
}
