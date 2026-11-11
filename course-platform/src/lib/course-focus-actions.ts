'use server';

import { runCourseAction, refreshTeaching, requireEditorAuthor } from './action-utils';
import { publishCourseDocument, saveCourseDocumentDraft, withdrawCourseDocument, type CourseDocumentInput, type CourseFocusContent } from './course-focus';
import type { CoursePublicationSummary } from './course-publication';

type CourseDocumentActionResult = { success?: string; error?: string; revision?: number; focus?: CourseFocusContent; review?: CoursePublicationSummary; summary?: CoursePublicationSummary };

export async function saveCourseDocumentAction(offeringId: string, input: CourseDocumentInput, acknowledgedVisibility?: string, expectedUserId?: string): Promise<CourseDocumentActionResult> {
  let saved: Awaited<ReturnType<typeof publishCourseDocument>> | undefined;
  const result = await runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId);
    saved = await publishCourseDocument(userId, offeringId, input, acknowledgedVisibility);
    if (!saved.focus) return {};
    refreshTeaching(offeringId);
    return { success: '课程页面已发布，学生可看到最新内容。' };
  });
  return { ...result, ...(!result.error && saved ? saved : {}), ...(saved?.focus ? { revision: saved.focus.revision } : {}) };
}

export async function saveCourseDocumentDraftAction(offeringId: string, input: CourseDocumentInput, expectedUserId?: string): Promise<CourseDocumentActionResult> {
  let focus: CourseFocusContent | undefined;
  const result = await runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId);
    focus = await saveCourseDocumentDraft(userId, offeringId, input);
    refreshTeaching(offeringId);
    return { success: '页面草稿已保存，学生看到的内容尚未改变。' };
  });
  return { ...result, ...(!result.error && focus ? { revision: focus.revision, focus } : {}) };
}

export async function withdrawCourseDocumentAction(offeringId: string, revision: number, expectedUserId?: string): Promise<CourseDocumentActionResult> {
  let focus: CourseFocusContent | undefined;
  const result = await runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId);
    focus = await withdrawCourseDocument(userId, offeringId, revision);
    refreshTeaching(offeringId);
    return { success: '课程首页正文已撤回为草稿。' };
  });
  return { ...result, ...(!result.error && focus ? { revision: focus.revision, focus } : {}) };
}
