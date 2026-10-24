'use server';

import { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentUser, requireSameOrigin } from './auth';
import type { FormState } from './form-state';
import { DomainError, addCourseMember, assignTa, createGroup, createOffering, endTaAssignment, moveStudentToGroup, saveGroupPage, setOfferingStatus } from './management';

const id = z.string().min(1).max(150);
const title = z.string().trim().min(1, '请填写名称。').max(100, '名称请控制在 100 字以内。');
const description = z.string().trim().max(2000, '介绍请控制在 2000 字以内。');

async function perform(work: (userId: string) => Promise<FormState>): Promise<FormState> {
  try {
    await requireSameOrigin();
    const user = await getCurrentUser();
    if (!user) return { error: '登录已过期，请重新进入课程。' };
    return await work(user.id);
  } catch (error) {
    if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? '请检查填写内容。' };
    if (error instanceof DomainError) return { error: error.message };
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return { error: '记录已存在，请刷新后重试。' };
    console.error('课程操作失败', error instanceof Error ? error.name : 'UnknownError');
    return { error: '操作未完成，请刷新页面后重试。' };
  }
}

function refreshOffering(offeringId: string) {
  revalidatePath('/courses');
  revalidatePath('/workspace');
  revalidatePath(`/courses/${offeringId}`, 'layout');
}

export async function createOfferingAction(courseId: string, _state: FormState, form: FormData): Promise<FormState> {
  return perform(async userId => {
    const values = z.object({ termId: z.string().max(150), description }).parse({ termId: String(form.get('termId') ?? ''), description: String(form.get('description') ?? '') });
    let termName: string | undefined, startDate: Date | undefined, endDate: Date | undefined;
    if (!values.termId) {
      termName = title.parse(String(form.get('termName') ?? ''));
      startDate = new Date(`${z.iso.date().parse(String(form.get('startDate') ?? ''))}T00:00:00+08:00`);
      endDate = new Date(`${z.iso.date().parse(String(form.get('endDate') ?? ''))}T23:59:59+08:00`);
    }
    const offering = await createOffering(userId, { courseId: id.parse(courseId), termId: values.termId || undefined, termName, startDate, endDate, description: values.description });
    refreshOffering(offering.id);
    return { redirectTo: `/courses/${offering.id}/manage?created=1` };
  });
}

export async function setOfferingStatusAction(offeringId: string, _state: FormState, form: FormData): Promise<FormState> {
  return perform(async userId => {
    await setOfferingStatus(userId, id.parse(offeringId), z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).parse(form.get('status')));
    refreshOffering(offeringId);
    return { success: '课程状态已更新。' };
  });
}

export async function addMemberAction(offeringId: string, _state: FormState, form: FormData): Promise<FormState> {
  return perform(async userId => {
    await addCourseMember(userId, id.parse(offeringId), id.parse(form.get('userId')), z.enum(['STUDENT', 'TA', 'TEACHER']).parse(form.get('role')));
    refreshOffering(offeringId);
    return { success: '已添加课程成员。' };
  });
}

export async function createGroupAction(offeringId: string, _state: FormState, form: FormData): Promise<FormState> {
  return perform(async userId => {
    await createGroup(userId, id.parse(offeringId), title.parse(form.get('name')), description.parse(String(form.get('description') ?? '')));
    refreshOffering(offeringId);
    return { success: '小组已创建，可以分配组员和负责助教。' };
  });
}

export async function moveStudentAction(offeringId: string, _state: FormState, form: FormData): Promise<FormState> {
  return perform(async userId => {
    await moveStudentToGroup(userId, id.parse(offeringId), id.parse(form.get('groupId')), id.parse(form.get('courseMemberId')));
    refreshOffering(offeringId);
    return { success: '小组成员已更新，原有入组记录已保留。' };
  });
}

export async function assignTaAction(offeringId: string, _state: FormState, form: FormData): Promise<FormState> {
  return perform(async userId => {
    await assignTa(userId, id.parse(offeringId), id.parse(form.get('groupId')), id.parse(form.get('courseMemberId')));
    refreshOffering(offeringId);
    return { success: '助教分工已保存。' };
  });
}

export async function endTaAction(offeringId: string, _state: FormState, form: FormData): Promise<FormState> {
  return perform(async userId => {
    await endTaAssignment(userId, id.parse(offeringId), id.parse(form.get('assignmentId')));
    refreshOffering(offeringId);
    return { success: '已结束这项助教分工，历史记录已保留。' };
  });
}

export async function saveGroupPageAction(offeringId: string, groupId: string, _state: FormState, form: FormData): Promise<FormState> {
  return perform(async userId => {
    await saveGroupPage(userId, id.parse(offeringId), id.parse(groupId), title.parse(form.get('title')), z.string().trim().min(1, '请填写小组介绍。').max(12000, '内容请控制在 12000 字以内。').parse(form.get('body')));
    refreshOffering(offeringId);
    return { success: '小组主页已保存，组员和本课程教学团队可查看。' };
  });
}
