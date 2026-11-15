'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { refreshTeaching, requireEditorAuthor, runCourseAction } from './action-utils';
import type { FormState } from './form-state';
import {
  GroupShowcaseDraftConflictError, GroupShowcaseMaterialsError,
  publishGroupShowcase, saveGroupShowcaseDraft, withdrawGroupShowcase,
} from './group-showcase';
import type { ShowcaseDraft, ShowcaseScope, ShowcaseSource } from './group-showcase-contract';

export type ShowcaseDraftConflict = { current: ShowcaseDraft & { revision: number }; sources: ShowcaseSource[] };

type DraftState = FormState & { revision?: number; conflict?: ShowcaseDraftConflict; unavailableSelections?: string[] };

export async function saveShowcaseDraftAction(
  offeringId: string, groupId: string, viewerId: string, expectedRevision: number, draft: ShowcaseDraft,
): Promise<DraftState> {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, viewerId ?? '');
    try {
      const saved = await saveGroupShowcaseDraft(userId, offeringId, groupId, expectedRevision, draft);
      refreshTeaching(offeringId);
      return { revision: saved.revision, success: '展示草稿已保存。' };
    } catch (error) {
      if (error instanceof GroupShowcaseDraftConflictError) {
        return { error: error.message, conflict: { current: error.current, sources: error.sources } };
      }
      if (error instanceof GroupShowcaseMaterialsError) {
        return { error: error.message, unavailableSelections: error.selectionKeys };
      }
      throw error;
    }
  });
}

export async function confirmShowcaseAction(
  offeringId: string, groupId: string, viewerId: string, scope: ShowcaseScope,
  revision: number, publicationToken: string | null,
) {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, viewerId ?? '');
    await publishGroupShowcase(userId, offeringId, groupId, z.enum(['CLASS', 'PUBLIC']).parse(scope), revision, publicationToken);
    refreshTeaching(offeringId);
    if (scope === 'PUBLIC') {
      revalidatePath('/');
      revalidatePath('/projects');
    }
    return { success: scope === 'CLASS' ? '已确认班内分享。' : '已确认互联网发布。' };
  });
}

export async function withdrawShowcaseAction(
  offeringId: string, groupId: string, viewerId: string, scope: ShowcaseScope, publicationId: string,
) {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, viewerId ?? '');
    await withdrawGroupShowcase(userId, offeringId, groupId, z.enum(['CLASS', 'PUBLIC']).parse(scope), publicationId);
    refreshTeaching(offeringId);
    if (scope === 'PUBLIC') {
      revalidatePath('/');
      revalidatePath('/projects');
    }
    return { success: scope === 'CLASS' ? '已撤回班内分享。' : '已撤回互联网发布。' };
  });
}
