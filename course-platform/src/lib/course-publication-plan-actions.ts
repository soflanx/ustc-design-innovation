'use server';

import { refreshTeaching, runCourseAction } from './action-utils';
import type { CourseAuthoredSnapshot } from './course-authored-page';
import type { CourseDocumentInput } from './course-focus';
import { applyCoursePublicationPlan, previewCoursePublicationPlan, type CoursePublicationPlan } from './course-publication-plan';
import { DomainError } from './management';

function verifyAuthor(userId: string, expectedUserId: string) {
  if (userId !== expectedUserId) throw new DomainError('登录账号已切换，请切回打开编辑器时的账号。你的内容尚未发布。');
}

export async function previewCoursePublicationPlanAction(offeringId: string, pageId: string | null, input: CourseDocumentInput, expectedUserId: string): Promise<{ plan?: CoursePublicationPlan; error?: string }> {
  let plan: CoursePublicationPlan | undefined;
  const result = await runCourseAction(async userId => {
    verifyAuthor(userId, expectedUserId);
    plan = await previewCoursePublicationPlan(userId, offeringId, pageId, input);
    return {};
  });
  return result.error ? { error: result.error } : { plan };
}

export async function applyCoursePublicationPlanAction(offeringId: string, pageId: string | null, input: CourseDocumentInput, expectedUserId: string, planKey: string, selectedKeys: string[]): Promise<{ page?: CourseAuthoredSnapshot; plan?: CoursePublicationPlan; error?: string }> {
  let saved: Awaited<ReturnType<typeof applyCoursePublicationPlan>> | undefined;
  const result = await runCourseAction(async userId => {
    verifyAuthor(userId, expectedUserId);
    saved = await applyCoursePublicationPlan(userId, offeringId, pageId, input, planKey, selectedKeys);
    if (saved.page) refreshTeaching(offeringId);
    return {};
  });
  return result.error ? { error: result.error } : saved ?? { error: '页面尚未发布。' };
}
