'use server';

import { authoredPageSnapshot, type CourseAuthoredSnapshot } from './course-authored-page';
import type { CourseDocumentInput } from './course-focus';
import { saveCourseDocumentAction, saveCourseDocumentDraftAction, withdrawCourseDocumentAction } from './course-focus-actions';
import type { CoursePublicationSummary } from './course-publication';
import { saveCourseSubpageAction, withdrawCourseSubpageAction } from './course-subpage-actions';

type PageResult = { page?: CourseAuthoredSnapshot; review?: CoursePublicationSummary; summary?: CoursePublicationSummary; error?: string };

// Both storage adapters authorize the user and scope the operation to this offering.
export async function saveAuthoredPageAction(offeringId: string, pageId: string | null, input: CourseDocumentInput, publish: boolean, acknowledgedVisibility?: string, expectedUserId?: string): Promise<PageResult> {
  if (typeof publish !== 'boolean') return { error: '页面保存方式无效。' };
  if (pageId !== null) {
    const result = await saveCourseSubpageAction(offeringId, pageId, input, publish, acknowledgedVisibility, expectedUserId);
    return { page: result.page && authoredPageSnapshot(result.page), review: result.review, summary: result.summary, error: result.error };
  }
  const result = publish ? await saveCourseDocumentAction(offeringId, input, acknowledgedVisibility, expectedUserId) : await saveCourseDocumentDraftAction(offeringId, input, expectedUserId);
  return { page: result.focus && authoredPageSnapshot(result.focus), review: result.review, summary: result.summary, error: result.error };
}

export async function withdrawAuthoredPageAction(offeringId: string, pageId: string | null, revision: number, expectedUserId?: string): Promise<PageResult> {
  if (pageId !== null) {
    const result = await withdrawCourseSubpageAction(offeringId, pageId, revision, expectedUserId);
    return { page: result.page && authoredPageSnapshot(result.page), error: result.error };
  }
  const result = await withdrawCourseDocumentAction(offeringId, revision, expectedUserId);
  return { page: result.focus && authoredPageSnapshot(result.focus), error: result.error };
}
