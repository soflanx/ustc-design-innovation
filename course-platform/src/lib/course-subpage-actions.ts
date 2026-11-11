'use server';

import { refreshTeaching, runCourseAction, requireEditorAuthor } from './action-utils';
import type { CourseDocumentInput } from './course-focus';
import type { CoursePublicationSummary } from './course-publication';
import { createCourseSubpage, saveCourseSubpage, withdrawCourseSubpage, type CourseSubpageContent, type CourseSubpageStarter } from './course-subpages';

export async function createCourseSubpageAction(offeringId: string, title: string, requestId: string, expectedUserId: string, starter?: CourseSubpageStarter): Promise<{ pageId?: string; error?: string }> {
  let pageId: string | undefined;
  const result = await runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    const page = await createCourseSubpage(userId, offeringId, title, requestId, starter);
    pageId = page.id;
    refreshTeaching(offeringId);
    return {};
  });
  return result.error ? { error: result.error } : { pageId };
}

export async function saveCourseSubpageAction(offeringId: string, pageId: string, input: CourseDocumentInput, publish: boolean, acknowledgedVisibility?: string, expectedUserId?: string): Promise<{ page?: CourseSubpageContent; review?: CoursePublicationSummary; summary?: CoursePublicationSummary; error?: string }> {
  let saved: Awaited<ReturnType<typeof saveCourseSubpage>> | undefined;
  const result = await runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId);
    saved = await saveCourseSubpage(userId, offeringId, pageId, input, publish, acknowledgedVisibility);
    if (saved.page) refreshTeaching(offeringId);
    return {};
  });
  return result.error ? { error: result.error } : saved ?? { error: '页面尚未保存。' };
}

export async function withdrawCourseSubpageAction(offeringId: string, pageId: string, revision: number, expectedUserId?: string): Promise<{ page?: CourseSubpageContent; error?: string }> {
  let page: CourseSubpageContent | undefined;
  const result = await runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId);
    page = await withdrawCourseSubpage(userId, offeringId, pageId, revision);
    refreshTeaching(offeringId);
    return {};
  });
  return result.error ? { error: result.error } : { page };
}
