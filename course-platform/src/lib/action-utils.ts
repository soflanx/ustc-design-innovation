import { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentUser, requireSameOrigin } from './auth';
import { DomainError } from './management';
import type { FormState } from './form-state';

export function requireEditorAuthor(userId: string, expectedUserId: string | undefined) {
  if (expectedUserId !== undefined && userId !== expectedUserId) {
    throw new DomainError('登录账号已切换，请切回打开编辑器时的账号。你的内容尚未写入。');
  }
}

export async function runCourseAction(work: (userId: string) => Promise<FormState>, signedOut: string | FormState = '登录已过期，请重新进入课程。'): Promise<FormState> {
  try {
    await requireSameOrigin();
    const user = await getCurrentUser();
    if (!user) return typeof signedOut === 'string' ? { error: signedOut } : signedOut;
    return await work(user.id);
  } catch (error) {
    if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? '请检查填写内容。' };
    if (error instanceof DomainError) return { error: error.message };
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return { error: '记录已存在，请刷新页面后检查。' };
    console.error('教学操作失败', error instanceof Error ? error.name : 'UnknownError');
    return { error: '操作未完成，请刷新页面后重试。' };
  }
}

export function refreshTeaching(offeringId: string) {
  revalidatePath(`/courses/${offeringId}`, 'layout');
  revalidatePath('/workspace');
}
