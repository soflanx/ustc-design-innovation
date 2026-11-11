'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentUser, requireSameOrigin } from './auth';
import { DomainError, OfferingIntroductionConflictError, saveOfferingIntroduction } from './management';

export type OfferingIntroductionResult =
  | { success: string; description: string }
  | { error: string; conflictDescription?: string };

export async function saveOfferingIntroductionAction(
  offeringId: string, authorId: string, expectedDescription: string, description: string,
): Promise<OfferingIntroductionResult> {
  try {
    await requireSameOrigin();
    const user = await getCurrentUser();
    if (!user) return { error: '登录已过期。请在另一个标签页登录原账号，再回此页保存。' };
    if (user.id !== authorId) return { error: '当前账号与开始编辑时不同。请切回原账号，再回此页保存。' };
    const saved = await saveOfferingIntroduction(user.id, offeringId, expectedDescription, description);
    const path = `/courses/${encodeURIComponent(offeringId)}`;
    revalidatePath(path);
    revalidatePath(path, 'layout');
    revalidatePath('/courses');
    const success = !saved.description ? '本期公开介绍已清空。'
      : saved.status === 'DRAFT' ? '本期介绍已保存，学期开放后访客可见。' : '本期介绍已保存，访客可在公开开课页阅读。';
    return { success, description: saved.description };
  } catch (error) {
    if (error instanceof OfferingIntroductionConflictError) return { error: error.message, conflictDescription: error.currentDescription };
    if (error instanceof DomainError) return { error: error.message };
    console.error('保存本期公开介绍失败', error instanceof Error ? error.name : 'UnknownError');
    return { error: '暂时无法确认保存结果，请保留当前文字并重试。' };
  }
}
