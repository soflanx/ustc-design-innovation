'use server';

import { z } from 'zod';
import type { FormState } from './form-state';
import { refreshTeaching, runCourseAction } from './action-utils';
import { createResource, updateResource, type ResourceInput } from './resource-service';

function values(form: FormData): ResourceInput {
  return {
    title: String(form.get('title') ?? ''),
    body: String(form.get('body') ?? ''),
    url: String(form.get('url') ?? ''),
    status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).parse(form.get('status')),
  };
}

export async function createResourceAction(offeringId: string, _state: FormState, form: FormData): Promise<FormState> {
  return runCourseAction(async userId => {
    const resource = await createResource(userId, offeringId, values(form));
    refreshTeaching(offeringId);
    return { redirectTo: `/courses/${offeringId}/resources/${resource.id}` };
  });
}

export async function updateResourceAction(offeringId: string, resourceId: string, _state: FormState, form: FormData): Promise<FormState> {
  return runCourseAction(async userId => {
    await updateResource(userId, offeringId, resourceId, values(form));
    refreshTeaching(offeringId);
    return { success: '资料已保存。只有本期课程成员可以查看已发布内容。' };
  });
}
