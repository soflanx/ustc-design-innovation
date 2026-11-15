'use server';

import { revalidatePath } from 'next/cache';
import { requireEditorAuthor, runCourseAction } from './action-utils';
import { courseNewsHref, publishCourseNews, saveCourseNewsDraft, withdrawCourseNews } from './course-news';
import type { FormState } from './form-state';

export async function saveCourseNewsDraftAction(
  offeringId: string, expectedUserId: string, target: { postId: string; revision: number } | null, requestId: string,
  _state: FormState, form: FormData,
): Promise<FormState> {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    const cover = form.get('cover');
    const saved = await saveCourseNewsDraft(userId, offeringId, target, requestId, {
      title: String(form.get('title') ?? ''), excerpt: String(form.get('excerpt') ?? ''), body: String(form.get('body') ?? ''),
      cover: cover instanceof File && (cover.size > 0 || cover.name) ? cover : undefined,
      coverAlt: String(form.get('coverAlt') ?? ''), coverCaption: String(form.get('coverCaption') ?? ''),
      removeCover: form.get('removeCover') === 'on',
    });
    revalidatePath(courseNewsHref(offeringId));
    revalidatePath(courseNewsHref(offeringId, saved.id));
    revalidatePath(courseNewsHref(offeringId, 'new'));
    return { success: '新闻草稿已保存。', redirectTo: courseNewsHref(offeringId, saved.id) };
  });
}

function refreshPublishedNews(offeringId: string, postId: string, slug: string) {
  revalidatePath(courseNewsHref(offeringId));
  revalidatePath(courseNewsHref(offeringId, postId));
  revalidatePath(`/courses/${encodeURIComponent(offeringId)}`);
  revalidatePath('/news');
  revalidatePath(`/news/${encodeURIComponent(slug)}`);
}

export async function publishCourseNewsAction(offeringId: string, expectedUserId: string, postId: string, revision: number, _state: FormState, _form: FormData) {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    const slug = await publishCourseNews(userId, offeringId, postId, revision);
    refreshPublishedNews(offeringId, postId, slug);
    return { success: '新闻已发布到互联网。' };
  });
}

export async function withdrawCourseNewsAction(
  offeringId: string, expectedUserId: string, postId: string, revision: number, publishedRevision: number | null,
  _state: FormState, _form: FormData,
) {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    const slug = await withdrawCourseNews(userId, offeringId, postId, revision, publishedRevision);
    refreshPublishedNews(offeringId, postId, slug);
    return { success: '公开新闻已撤回。' };
  });
}
