'use server';

import { z } from 'zod';
import type { FormState } from './form-state';
import { refreshTeaching, runCourseAction } from './action-utils';
import { createResource, ResourceRevisionConflictError, updateResource, type ResourceInput } from './resource-service';

function values(form: FormData): ResourceInput {
  const entry = form.get('file');
  const file = entry instanceof File && entry.name ? entry : undefined;
  return {
    title: String(form.get('title') ?? '').trim() || file?.name.slice(0, 100) || '',
    body: String(form.get('body') ?? ''),
    url: String(form.get('url') ?? ''),
    status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).parse(form.get('status')),
    file,
  };
}

export async function createResourceAction(offeringId: string, _state: FormState, form: FormData): Promise<FormState> {
  return runCourseAction(async userId => {
    const requestId = String(form.get('requestId') || '');
    await createResource(userId, offeringId, values(form), requestId || undefined);
    refreshTeaching(offeringId);
    return { redirectTo: `/courses/${offeringId}/resources` };
  });
}

export type ResourceEditState = FormState & { revisionConflict?: true };

export async function updateResourceAction(offeringId: string, resourceId: string, _state: FormState, form: FormData): Promise<ResourceEditState> {
  return runCourseAction(async (userId): Promise<ResourceEditState> => {
    if (form.get('expectedUserId') !== userId) return {
      error: '当前登录账号与开始编辑时不同。草稿已保留，请在另一个标签页切回原账号，再回此页保存。',
    };
    try {
      await updateResource(userId, offeringId, resourceId, values(form), Number(form.get('expectedRevision')));
    } catch (error) {
      if (error instanceof ResourceRevisionConflictError) return {
        error: '资料已有更新。草稿已保留，请核对最新版。', revisionConflict: true,
      };
      throw error;
    }
    refreshTeaching(offeringId);
    return { success: '资料已保存。只有本期课程成员可以查看已发布内容。' };
  }, '登录已过期。草稿已保留，请在另一个标签页登录原账号，再回此页保存。');
}
