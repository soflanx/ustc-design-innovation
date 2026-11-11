import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type CourseSubpage, type MemberRole } from '@prisma/client';
import { z } from 'zod';
import { courseDocumentTitle, createMarkdownBlock, type CourseBlock, type CourseDocument } from './course-document';
import { courseDocumentForReader, courseDocumentForWrite, courseDocumentTransaction, coursePageAccess, type CourseDocumentInput, type CourseFocusDraft } from './course-focus';
import type { CoursePublicationSummary } from './course-publication';
import { checkCoursePagePublication } from './course-page-publication';
import { DomainError } from './management';
import { db } from './db';

export type CourseSubpageSummary = { id: string; title: string; publishedTitle: string | null; publishedAt: Date | null; hasDraft: boolean };
export type CourseSubpageContent = {
  id: string;
  title: string;
  document: CourseDocument;
  publishedAt: Date | null;
  revision: number;
  draft?: CourseFocusDraft;
};
export type CourseSubpageSaveResult = { page: CourseSubpageContent; summary?: CoursePublicationSummary; review?: never } | { review: CoursePublicationSummary; page?: never; summary?: never };

const titleSchema = z.string().trim().min(1, '请填写页面标题。').max(100, '标题请控制在 100 字以内。');
const saveSchema = z.object({ title: titleSchema, revision: z.number().int().positive('页面版本无效。') });
const starterSchema = z.object({
  body: z.string().trim().max(12000, '课次正文请控制在 12000 字以内。').default(''),
  assignmentId: z.string().min(1).max(200).optional(),
  resourceId: z.string().min(1).max(200).optional(),
});
export type CourseSubpageStarter = z.input<typeof starterSchema>;
const emptyDocument = { version: 1, blocks: [] } satisfies CourseDocument;
type Access = Awaited<ReturnType<typeof coursePageAccess>>;

async function visibleContent(tx: Prisma.TransactionClient, row: CourseSubpage, access: Access): Promise<CourseSubpageContent> {
  const page: CourseSubpageContent = {
    id: row.id, title: row.title, publishedAt: row.publishedAt,
    document: await courseDocumentForReader(tx, row.offeringId, row.document, access),
    revision: access.readDraft ? row.revision : 0,
  };
  if (access.readDraft && row.draftDocument !== null) {
    page.draft = {
      title: row.draftTitle!, savedAt: row.draftSavedAt,
      document: await courseDocumentForReader(tx, row.offeringId, row.draftDocument, access),
    };
  }
  return page;
}

export async function listCourseSubpages(userId: string, offeringId: string): Promise<{ pages: CourseSubpageSummary[]; canEdit: boolean }> {
  return courseDocumentTransaction(async tx => {
    const access = await coursePageAccess(tx, userId, offeringId);
    const rows = await tx.courseSubpage.findMany({
      where: { offeringId, ...(access.readDraft ? {} : { publishedAt: { not: null } }) },
      select: { id: true, title: true, publishedAt: true, draftTitle: access.readDraft },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return {
      pages: rows.map(row => ({
        id: row.id, title: row.draftTitle ?? row.title, publishedTitle: row.publishedAt ? row.title : null,
        publishedAt: row.publishedAt, hasDraft: row.draftTitle != null,
      })),
      canEdit: access.canEdit,
    };
  });
}

export async function getCourseSubpage(userId: string, offeringId: string, pageId: string): Promise<{ page: CourseSubpageContent | null; canEdit: boolean }> {
  return courseDocumentTransaction(async tx => {
    const access = await coursePageAccess(tx, userId, offeringId);
    const row = await tx.courseSubpage.findFirst({
      where: { id: pageId, offeringId, ...(access.readDraft ? {} : { publishedAt: { not: null } }) },
    });
    return { page: row ? await visibleContent(tx, row, access) : null, canEdit: access.canEdit };
  });
}

/** Resolve only the title needed for a return link after course access was checked. */
export async function getGroupActivitySource(
  user: { id: string; isAdmin: boolean }, offeringId: string, pageId: string | undefined,
  role: MemberRole | undefined,
) {
  if (!pageId || (!user.isAdmin && !role)) return null;
  const readDraft = user.isAdmin || role === 'TEACHER' || role === 'TA';
  const row = await db.courseSubpage.findFirst({
    where: {
      id: pageId, offeringId,
      ...(readDraft ? {} : { publishedAt: { not: null } }),
      ...(user.isAdmin ? {} : { offering: { members: { some: { userId: user.id, status: 'ACTIVE', role } } } }),
    },
    select: { id: true, title: true, publishedAt: true, draftTitle: readDraft },
  });
  // The activity opens in reading mode, which uses the published title until
  // a new revision is published. Staff can also navigate back to a draft.
  return row && { id: row.id, title: row.publishedAt ? row.title : row.draftTitle ?? row.title };
}

export async function createCourseSubpage(userId: string, offeringId: string, title: string, requestId: string = randomUUID(), starter?: CourseSubpageStarter): Promise<CourseSubpageContent> {
  return courseDocumentTransaction(async tx => {
    const access = await coursePageAccess(tx, userId, offeringId, true);
    const name = titleSchema.parse(title);
    const id = z.string().uuid('新建请求无效，请重新打开表单。').parse(requestId);
    const { body, assignmentId, resourceId } = starterSchema.parse(starter ?? {});
    const fingerprint = createHash('sha256').update(JSON.stringify(body || assignmentId || resourceId
      ? [userId, name, body, assignmentId, resourceId] : [userId, name])).digest('hex');
    const existing = await tx.courseSubpage.findUnique({ where: { id } });
    if (existing) {
      if (existing.offeringId !== offeringId || existing.creationFingerprint !== fingerprint) {
        throw new DomainError('新建请求已使用，请重新创建页面。');
      }
      return visibleContent(tx, existing, access);
    }

    if (assignmentId && !await tx.assignment.findFirst({
      where: { offeringId, id: assignmentId, status: 'PUBLISHED' }, select: { id: true },
    })) throw new DomainError('请选择本期已发布的作业。');
    // Published resources are readable by this offering's members. Quick
    // preparation uses that audience even when the editor can read drafts.
    if (resourceId && !await tx.resource.findFirst({
      where: { offeringId, id: resourceId, status: 'PUBLISHED' }, select: { id: true },
    })) throw new DomainError('请选择本期已发布的资料。');

    const blocks: CourseBlock[] = [];
    if (body) blocks.push(createMarkdownBlock('lesson-body', body));
    if (assignmentId) blocks.push({ id: 'lesson-assignment', type: 'courseRecord', props: { kind: 'assignments', recordId: assignmentId, display: 'link' }, children: [] });
    if (resourceId) blocks.push({ id: 'lesson-resource', type: 'courseRecord', props: { kind: 'resources', recordId: resourceId, display: 'link' }, children: [] });
    const draft = { ...emptyDocument, blocks };
    // A retried create must not add a duplicate page or reset an existing draft.
    await tx.courseSubpage.createMany({ skipDuplicates: true, data: {
      id, offeringId, creationFingerprint: fingerprint, document: emptyDocument,
      draftTitle: name, draftDocument: draft, draftSavedAt: new Date(),
    } });
    const row = await tx.courseSubpage.findFirst({ where: { id, offeringId, creationFingerprint: fingerprint } });
    if (!row) throw new DomainError('新建请求已使用，请重新创建页面。');
    return visibleContent(tx, row, access);
  });
}

export async function prepareCourseSubpage(tx: Prisma.TransactionClient, userId: string, offeringId: string, pageId: string, input: CourseDocumentInput) {
  const access = await coursePageAccess(tx, userId, offeringId, true);
  const { title: fallbackTitle, revision } = saveSchema.parse(input);
  const row = await tx.courseSubpage.findFirst({ where: { id: pageId, offeringId } });
  if (!row) throw new DomainError('子页面不存在或不可访问。');
  if (revision !== row.revision) throw new DomainError('另一位成员已更新此页面，请保留当前编辑并重新载入最新版本。');
  const document = await courseDocumentForWrite(tx, offeringId, input.document, row.draftDocument ?? row.document, access, 'subpage');
  return { access, document, title: courseDocumentTitle(document, fallbackTitle), revision };
}

export async function commitCourseSubpage(tx: Prisma.TransactionClient, offeringId: string, pageId: string, prepared: Awaited<ReturnType<typeof prepareCourseSubpage>>, publish: boolean) {
  const { access, document, title, revision } = prepared;
  const value = document as unknown as Prisma.InputJsonValue;
  const now = new Date();
  const changes = publish
    ? { title, document: value, publishedAt: now, draftTitle: null, draftDocument: Prisma.DbNull, draftSavedAt: null }
    : { draftTitle: title, draftDocument: value, draftSavedAt: now };
  const saved = await tx.courseSubpage.updateMany({ where: { id: pageId, offeringId, revision }, data: { ...changes, revision: { increment: 1 } } });
  if (saved.count !== 1) throw new DomainError('页面已更新，请保留当前编辑并重新载入最新版本。');
  const updated = await tx.courseSubpage.findUniqueOrThrow({ where: { id: pageId } });
  return visibleContent(tx, updated, access);
}

export async function saveCourseSubpage(userId: string, offeringId: string, pageId: string, input: CourseDocumentInput, publish: boolean, acknowledgedVisibility?: string): Promise<CourseSubpageSaveResult> {
  return courseDocumentTransaction(async tx => {
    z.boolean().parse(publish);
    const prepared = await prepareCourseSubpage(tx, userId, offeringId, pageId, input);
    let summary: CoursePublicationSummary | undefined;
    if (publish) {
      const visible = await courseDocumentForReader(tx, offeringId, prepared.document, prepared.access, false, { forPublication: true });
      const decision = await checkCoursePagePublication(tx, offeringId, visible, acknowledgedVisibility);
      if (decision.review) return { review: decision.review };
      summary = decision.summary;
    }
    return { page: await commitCourseSubpage(tx, offeringId, pageId, prepared, publish), summary };
  });
}

/** Stop serving the published page without overwriting newer, unpublished edits. */
export async function withdrawCourseSubpage(userId: string, offeringId: string, pageId: string, revision: number): Promise<CourseSubpageContent> {
  return courseDocumentTransaction(async tx => {
    const access = await coursePageAccess(tx, userId, offeringId, true);
    saveSchema.shape.revision.parse(revision);
    const row = await tx.courseSubpage.findFirst({ where: { id: pageId, offeringId } });
    if (!row) throw new DomainError('子页面不存在或不可访问。');
    if (row.revision !== revision) throw new DomainError('另一位成员已更新此页面，请重新载入后再撤回。');
    if (!row.publishedAt) throw new DomainError('此页面目前是草稿。');
    const saved = await tx.courseSubpage.updateMany({
      where: { id: pageId, offeringId, revision, publishedAt: { not: null } },
      data: {
        publishedAt: null, revision: { increment: 1 },
        ...(row.draftDocument === null ? { draftTitle: row.title, draftDocument: row.document as Prisma.InputJsonValue, draftSavedAt: new Date() } : {}),
      },
    });
    if (saved.count !== 1) throw new DomainError('页面已更新，请重新载入后再撤回。');
    const updated = await tx.courseSubpage.findUniqueOrThrow({ where: { id: pageId } });
    return visibleContent(tx, updated, access);
  });
}
