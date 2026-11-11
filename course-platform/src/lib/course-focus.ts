import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from './db';
import { checkCoursePagePublication } from './course-page-publication';
import type { CoursePublicationSummary } from './course-publication';
import { DomainError } from './management';
import { canManageOffering, canViewOffering } from './policy';
import { collectCourseReferences, courseDocumentTitle, courseHomeLessonSlots, CourseDocumentError, createMarkdownBlock, expandCourseHomeLessonNotes, legacyCourseDocument, normalizeCourseDocument, parseCourseDocument, readMarkdownSource, type CourseBlock, type CourseDocument } from './course-document';
import { CourseMarkdownReferenceError, inspectCourseMarkdownVisibility } from './course-markdown-references';

const focusInput = z.object({
  title: z.string().trim().min(1, '请填写当前教学内容的标题。').max(100, '标题请控制在 100 字以内。'),
  body: z.string().trim().max(12000, '教学说明请控制在 12000 字以内。'),
  assignmentIds: z.array(z.string().min(1).max(200)).max(500, '关联作业过多。'),
  resourceIds: z.array(z.string().min(1).max(200)).max(500, '关联资料过多。'),
});

export type CourseFocusInput = z.input<typeof focusInput>;
export type CourseFocusDraft = { title: string; document: CourseDocument; savedAt: Date | null };
export type CourseFocusContent = {
  title: string;
  body: string;
  assignmentIds: string[];
  resourceIds: string[];
  updatedAt: Date;
  document: CourseDocument;
  revision: number;
  publishedAt: Date | null;
  draft?: CourseFocusDraft;
};
type Tx = Prisma.TransactionClient;

async function focusAccess(client: Tx, userId: string, offeringId: string, write = false) {
  // Serializable transactions share one connection, so read authorization sequentially.
  const user = await client.user.findUnique({ where: { id: userId } });
  const offering = await client.courseOffering.findUnique({ where: { id: offeringId } });
  const member = await client.courseMember.findUnique({ where: { offeringId_userId: { offeringId, userId } } });
  if (!user || !offering || !canViewOffering(user.isAdmin, member)) throw new DomainError('你没有访问这门课程的权限。');
  const staff = user.isAdmin || (member?.status === 'ACTIVE' && (member.role === 'TEACHER' || member.role === 'TA'));
  if (write && !staff) throw new DomainError('只有本期教师、助教或管理员可以编辑当前教学内容。');
  if (write && offering.status === 'ARCHIVED') throw new DomainError('已归档学期的教学内容保持只读。');
  return {
    canEdit: staff && offering.status !== 'ARCHIVED',
    readDraft: staff,
    readAllAssignments: staff,
    // Focus editing does not grant a TA access to draft or withdrawn materials.
    readAllResources: canManageOffering(user.isAdmin, member),
    readAllGroups: staff,
    memberId: member?.id,
  };
}

async function transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) {
      // pg adapter errors may retain SQLSTATE instead of being wrapped as P2034.
      if (isSerializationConflict(error)) {
        if (attempt < 2) continue;
        throw new DomainError('页面正在更新，请保留当前编辑并重试。');
      }
      throw error;
    }
  }
  throw new DomainError('教学内容正在更新，请重试。');
}

function isSerializationConflict(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false;
  const value = error as Record<string, unknown>;
  return value.code === 'P2034' || value.code === '40001' || value.originalCode === '40001' || value.kind === 'TransactionWriteConflict'
    || ['cause', 'meta', 'driverAdapterError'].some(key => isSerializationConflict(value[key], depth + 1));
}

type Access = Awaited<ReturnType<typeof focusAccess>>;
async function storedFocus(client: Tx, offeringId: string) {
  return client.courseFocus.findUnique({
    where: { offeringId },
    include: {
      assignments: {
        select: { assignmentId: true },
        orderBy: { assignmentId: 'asc' },
      },
      resources: {
        select: { resourceId: true },
        orderBy: { resourceId: 'asc' },
      },
    },
  });
}
type StoredFocus = NonNullable<Awaited<ReturnType<typeof storedFocus>>>;
function rawStoredDocument(focus: StoredFocus) {
  return focus.document === null ? legacyCourseDocument({ body: focus.body, assignmentIds: focus.assignments.map(link => link.assignmentId), resourceIds: focus.resources.map(link => link.resourceId) }, { normalize: false }) : parseDocument(focus.document, true);
}
async function storedDocument(client: Tx, offeringId: string, focus: StoredFocus): Promise<CourseDocument> {
  return normalizeForCourse(client, offeringId, rawStoredDocument(focus), true);
}
function parseDocument(value: unknown, home = false) {
  try { return parseCourseDocument(value, { home }); }
  catch (error) { if (error instanceof CourseDocumentError) throw new DomainError(error.message); throw error; }
}
async function normalizeForCourse(client: Tx, offeringId: string, raw: CourseDocument, home = false): Promise<CourseDocument> {
  const document = home ? expandCourseHomeLessonNotes(raw) : raw;
  // A legacy view title was hidden when none of its records were readable.
  // Only universally readable views may become shared native headings without
  // an explicit user edit. This decision is identical for teachers and students.
  const references = collectCourseReferences(document);
  const assignments = await client.assignment.findMany({ where: { offeringId, id: { in: references.assignmentIds }, status: { in: ['PUBLISHED', 'ARCHIVED', 'CANCELLED'] } }, select: { id: true } });
  const resources = await client.resource.findMany({ where: { offeringId, id: { in: references.resourceIds }, status: 'PUBLISHED' }, select: { id: true } });
  const publicAssignments = new Set(assignments.map(row => row.id)), publicResources = new Set(resources.map(row => row.id));
  const preserveViewIds = new Set<string>();
  const visit = (blocks: CourseBlock[]) => blocks.forEach(block => {
    if (block.type === 'courseData' && block.props.grouped !== true) {
      const ids = JSON.parse(String(block.props.ids)) as string[];
      const publicIds = block.props.kind === 'assignments' ? publicAssignments : publicResources;
      if (!ids.length || block.props.kind === 'groups' || ids.some(id => !publicIds.has(id))) preserveViewIds.add(block.id);
    }
    visit(block.children ?? []);
  });
  visit(document.blocks);
  return parseDocument(normalizeCourseDocument(document, { preserveViewIds }), home);
}
async function readableReferences(client: Tx, offeringId: string, document: CourseDocument, access: Access) {
  const references = collectCourseReferences(document);
  const assignments = await client.assignment.findMany({ where: { offeringId, id: { in: references.assignmentIds }, ...(access.readAllAssignments ? {} : { status: { in: ['PUBLISHED', 'ARCHIVED', 'CANCELLED'] as ('PUBLISHED' | 'ARCHIVED' | 'CANCELLED')[] } }) }, select: { id: true } });
  const resources = await client.resource.findMany({ where: { offeringId, id: { in: references.resourceIds }, ...(access.readAllResources ? {} : { status: 'PUBLISHED' as const }) }, select: { id: true } });
  const groups = await client.group.findMany({ where: { offeringId, id: { in: references.groupIds }, ...(access.readAllGroups ? {} : { members: { some: { courseMemberId: access.memberId ?? '', leftAt: null } } }) }, select: { id: true } });
  const pages = references.pageIds.length ? await client.courseSubpage.findMany({
    where: { offeringId, id: { in: references.pageIds }, ...(access.readDraft ? {} : { publishedAt: { not: null } }) },
    select: { id: true, publishedAt: true },
  }) : [];
  return {
    assignments: new Set(assignments.map(row => row.id)), resources: new Set(resources.map(row => row.id)),
    groups: new Set(groups.map(row => row.id)), pages: new Set(pages.map(row => row.id)),
    publishedPages: new Set(pages.filter(row => row.publishedAt).map(row => row.id)),
  };
}
type Readable = Awaited<ReturnType<typeof readableReferences>>;
const idsOf = (block: CourseBlock): string[] => block.type === 'courseRecord' ? block.props.recordId ? [String(block.props.recordId)] : [] : JSON.parse(String(block.props.ids));
const referenceProps = (block: CourseBlock, ids: string[]): CourseBlock['props'] => ({ ...block.props, ...(block.type === 'courseRecord' ? { recordId: ids[0] ?? '' } : { ids: JSON.stringify(ids) }) });
// A fingerprint detects visibility changes while the editor was open, without disclosing references.
const lockedId = (id: string, hiddenIds: string[]) => `__locked_${createHash('sha256').update(JSON.stringify([...hiddenIds].sort())).digest('hex').slice(0, 12)}_${id}`;
function markdownProjection(block: CourseBlock, readable: Readable, access: Access) {
  const original = readMarkdownSource(block);
  const projection = inspectCourseMarkdownVisibility(original, ({ kind, id }) => readable[kind].has(id), access.canEdit && !access.readAllResources);
  return {
    original,
    visible: projection.source,
    locked: projection.protected && { ...projection.protected, id: lockedId(block.id, projection.protected.resourceIds) },
  };
}
function projectDocument(document: CourseDocument, readable: Readable, access: Access, forPublication = false): CourseDocument {
  const used = new Set<string>();
  const index = (blocks: CourseBlock[]) => blocks.forEach(block => { used.add(block.id); index(block.children ?? []); });
  index(document.blocks);
  function markdownSlice(block: CourseBlock, position: 'before' | 'after', source: string): CourseBlock[] {
    if (!source.trim()) return [];
    const base = `markdown-${position}-${block.id.slice(0, 90)}`;
    let id = base;
    for (let suffix = 1; used.has(id); suffix++) id = `${base}-${suffix}`;
    used.add(id);
    return [{ ...block, id, content: createMarkdownBlock(id, source).content, children: [] }];
  }
  const project = (blocks: CourseBlock[]): CourseBlock[] => blocks.flatMap(block => {
    const children = project(block.children ?? []);
    if (block.type === 'markdown') {
      const { original, visible, locked } = markdownProjection(block, readable, access);
      const placeholder: CourseBlock[] = locked ? [{ id: locked.id, type: 'protected', props: {}, children: [] }] : [];
      if (locked && !forPublication) {
        const parts = [...markdownSlice(block, 'before', locked.before), ...placeholder, ...markdownSlice(block, 'after', locked.after)];
        parts[parts.length - 1].children = children;
        return parts;
      }
      const result = visible === original ? [{ ...block, children }] : visible.trim()
        ? [{ ...block, content: createMarkdownBlock(block.id, visible).content, children }] : children;
      return [...result, ...placeholder];
    }
    if (block.type !== 'courseData' && block.type !== 'courseRecord') return [{ ...block, children }];
    const ids = idsOf(block);
    const allowed = readable[block.props.kind as keyof Readable];
    const visible = ids.filter(id => allowed.has(id));
    const result: CourseBlock[] = visible.length || (access.canEdit && ids.length === 0)
      ? [{ ...block, props: referenceProps(block, visible), children }] : children;
    if (access.canEdit && block.props.kind === 'resources' && visible.length < ids.length) result.push({ id: lockedId(block.id, ids.filter(id => !allowed.has(id))), type: 'protected', props: {}, children: [] });
    return result;
  });
  return { ...document, blocks: project(document.blocks) };
}

/** Both the course home and its pages resolve references using the current reader. */
export async function courseDocumentForReader(client: Tx, offeringId: string, raw: unknown, access: Access, home = false, { forPublication = false } = {}) {
  const document = await normalizeForCourse(client, offeringId, parseDocument(raw, home), home);
  return projectDocument(document, await readableReferences(client, offeringId, document, access), access, forPublication);
}

async function readFocus(client: Tx, offeringId: string, access: Access): Promise<CourseFocusContent | null> {
  const focus = await storedFocus(client, offeringId);
  if (!focus) return null;
  const stored = await storedDocument(client, offeringId, focus);
  const readable = await readableReferences(client, offeringId, stored, access);
  let draft: CourseFocusDraft | undefined;
  if (access.readDraft && focus.draftDocument !== null) {
    draft = { title: focus.draftTitle ?? '', document: await courseDocumentForReader(client, offeringId, focus.draftDocument, access, true), savedAt: focus.draftSavedAt };
  }
  return {
    title: focus.title,
    // Once a block document is published it is the only public body. Keep the
    // legacy column in storage for migration, but never return removed text.
    body: focus.document === null ? focus.body : '',
    assignmentIds: [...readable.assignments].sort(),
    resourceIds: [...readable.resources].sort(),
    updatedAt: focus.updatedAt,
    document: projectDocument(stored, readable, access),
    revision: focus.revision,
    publishedAt: focus.publishedAt,
    ...(draft ? { draft } : {}),
  };
}

export async function getCourseFocus(userId: string, offeringId: string): Promise<{ focus: CourseFocusContent | null; canEdit: boolean }> {
  return transaction(async tx => {
    const access = await focusAccess(tx, userId, offeringId);
    return { focus: await readFocus(tx, offeringId, access), canEdit: access.canEdit };
  });
}

export async function saveCourseFocus(userId: string, offeringId: string, input: CourseFocusInput): Promise<CourseFocusContent> {
  return transaction(async tx => {
    const access = await focusAccess(tx, userId, offeringId, true);
    const previous = await tx.courseFocus.findUnique({ where: { offeringId }, select: { document: true, draftDocument: true } });
    if (previous && (previous.document !== null || previous.draftDocument !== null)) throw new DomainError('此页面已升级为内容块，请刷新后使用页面编辑器保存。');
    const parsed = focusInput.safeParse(input);
    if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message || '请检查填写内容。');
    const { title, body } = parsed.data;
    const assignmentIds = [...new Set(parsed.data.assignmentIds)];
    const resourceIds = [...new Set(parsed.data.resourceIds)];
    const assignments = await tx.assignment.findMany({
      where: { offeringId, id: { in: assignmentIds } }, select: { id: true },
    });
    if (assignments.length !== assignmentIds.length) throw new DomainError('请选择本学期的有效作业。');
    const resources = await tx.resource.findMany({
      where: { offeringId, id: { in: resourceIds }, ...(access.readAllResources ? {} : { status: 'PUBLISHED' as const }) },
      select: { id: true },
    });
    if (resources.length !== resourceIds.length) throw new DomainError('请选择本学期可读取的有效资料。');

    // A TA cannot see these links in the editor. Preserve them while replacing
    // only the published resources that a TA can actually select or remove.
    const protectedResources = access.readAllResources ? [] : await tx.courseFocusResource.findMany({
      where: { offeringId, resource: { status: { not: 'PUBLISHED' } } }, select: { resourceId: true },
    });
    const nextResourceIds = [...new Set([...resourceIds, ...protectedResources.map(link => link.resourceId)])];

    const publishedAt = new Date();
    await tx.courseFocus.upsert({
      where: { offeringId }, create: { offeringId, title, body, revision: 1, publishedAt }, update: { title, body, revision: { increment: 1 }, publishedAt },
    });
    await tx.courseFocusAssignment.deleteMany({ where: { offeringId } });
    await tx.courseFocusResource.deleteMany({ where: { offeringId } });
    if (assignmentIds.length) await tx.courseFocusAssignment.createMany({ data: assignmentIds.map(assignmentId => ({ offeringId, assignmentId })) });
    if (nextResourceIds.length) await tx.courseFocusResource.createMany({ data: nextResourceIds.map(resourceId => ({ offeringId, resourceId })) });
    return (await readFocus(tx, offeringId, access))!;
  });
}

export type CourseDocumentInput = { title: string; document: CourseDocument; revision: number };

/** Restore references a TA cannot see, using only the server's current document. */
function mergeProtected(incoming: CourseDocument, stored: CourseDocument, readable: Readable, access: Access, home: boolean) {
  const protectedBlocks = new Map<string, CourseBlock>();
  const visit = (blocks: CourseBlock[]) => blocks.forEach(block => {
    if (!access.readAllResources) {
      if ((block.type === 'courseData' || block.type === 'courseRecord') && block.props.kind === 'resources') {
        const hidden = idsOf(block).filter(id => !readable.resources.has(id));
        if (hidden.length) protectedBlocks.set(lockedId(block.id, hidden), { ...block, props: referenceProps(block, hidden), children: [] });
      }
      if (block.type === 'markdown') {
        const { locked } = markdownProjection(block, readable, access);
        if (locked) protectedBlocks.set(locked.id, { ...block, content: createMarkdownBlock(block.id, locked.source).content, children: [] });
      }
    }
    visit(block.children ?? []);
  });
  visit(stored.blocks);
  const incomingById = new Map<string, CourseBlock>();
  const index = (blocks: CourseBlock[]) => blocks.forEach(block => { incomingById.set(block.id, block); index(block.children ?? []); });
  const next = structuredClone(incoming);
  index(next.blocks);
  function unusedId(base: string) {
    let id = base;
    for (let suffix = 1; incomingById.has(id); suffix++) id = `retained-${base.slice(0, 100)}-${suffix}`;
    return id;
  }
  const retained = new Map<string, CourseBlock>();
  for (const [key, hidden] of protectedBlocks) {
    const visible = incomingById.get(hidden.id);
    // Only a multi-record view can merge a hidden reference into an editable
    // projection. Replacing an opaque single record must retain it separately.
    if (hidden.type === 'courseData' && visible?.type === 'courseData' && visible.props.kind === 'resources') {
      visible.props.ids = JSON.stringify([...new Set([...idsOf(visible), ...idsOf(hidden)])]);
    } else {
      // Keep the opaque Markdown block identity stable across save followed
      // by publish, since the editor retains its local source and undo stack.
      if (hidden.type === 'markdown' && visible) {
        visible.id = unusedId(hidden.id);
        if (next.titleBlockId === hidden.id) next.titleBlockId = visible.id;
        incomingById.delete(hidden.id);
        incomingById.set(visible.id, visible);
      }
      const id = unusedId(hidden.id);
      retained.set(key, { ...hidden, id });
      incomingById.set(id, hidden);
    }
  }
  const merge = (blocks: CourseBlock[]): CourseBlock[] => blocks.flatMap(block => {
    if (block.type !== 'protected') return [{ ...block, children: merge(block.children ?? []) }];
    if (!protectedBlocks.has(block.id)) throw new DomainError('资料的可见范围已改变，请保留当前编辑并重新载入页面。');
    const hidden = retained.get(block.id);
    retained.delete(block.id);
    const children = merge(block.children ?? []);
    if (hidden?.type === 'markdown') return [{ ...hidden, children }];
    return [...(hidden ? [hidden] : []), ...children];
  });
  const blocks = merge(next.blocks);
  // Deleting an opaque placeholder must never delete inaccessible records.
  blocks.push(...retained.values());
  return parseDocument({ ...next, blocks }, home);
}

export async function courseDocumentForWrite(tx: Tx, offeringId: string, incomingValue: unknown, originalValue: unknown, access: Access, destination: 'home' | 'subpage') {
  const home = destination === 'home';
  const incomingRaw = parseDocument(incomingValue, home);
  if (!home && incomingRaw.lessonNotes) throw new DomainError('旧课堂提示只在课程首页编辑。');
  const incoming = await normalizeForCourse(tx, offeringId, incomingRaw, home);
  let incomingRefs: ReturnType<typeof collectCourseReferences>;
  try { incomingRefs = collectCourseReferences(incoming, { strictMarkdown: true }); }
  catch (error) { if (error instanceof CourseMarkdownReferenceError) throw new DomainError(error.message); throw error; }
  if (!home && incomingRefs.pageIds.length) throw new DomainError('只有课程首页可以关联课程子页面。');
  const readableIncoming = await readableReferences(tx, offeringId, incoming, access);
  if (readableIncoming.assignments.size !== incomingRefs.assignmentIds.length) throw new DomainError('请选择本学期可读取的有效作业。');
  if (readableIncoming.resources.size !== incomingRefs.resourceIds.length) throw new DomainError('请选择本学期可读取的有效资料。');
  if (readableIncoming.groups.size !== incomingRefs.groupIds.length) throw new DomainError('请选择本学期可读取的有效小组。');
  if (readableIncoming.pages.size !== incomingRefs.pageIds.length) throw new DomainError('请选择本学期可读取的课程子页面。');
  const originalRaw = parseDocument(originalValue, home);
  const original = await normalizeForCourse(tx, offeringId, originalRaw, home);
  for (const slot of courseHomeLessonSlots) {
    const pageId = incomingRaw.lessonNotes?.[slot]?.pageId;
    // Preserve an existing link through withdrawal, while only allowing new links to published lessons.
    if (pageId && pageId !== originalRaw.lessonNotes?.[slot]?.pageId && !readableIncoming.publishedPages.has(pageId)) {
      throw new DomainError('请选择本学期已发布的课次。');
    }
  }
  const readableOriginal = await readableReferences(tx, offeringId, original, access);
  return mergeProtected(incoming, original, readableOriginal, access, home);
}

export async function prepareCourseDocument(tx: Tx, userId: string, offeringId: string, input: CourseDocumentInput) {
  const access = await focusAccess(tx, userId, offeringId, true);
  const parsed = z.object({ title: focusInput.shape.title, revision: z.number().int().min(0) }).safeParse(input);
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message || '页面版本无效，请重新载入。');
  const previous = await storedFocus(tx, offeringId);
  if ((previous?.revision ?? 0) !== parsed.data.revision) throw new DomainError('另一位成员已更新此页面。你的编辑尚未保存，请保留内容并重新载入最新版本。');
  const original = previous?.draftDocument ?? previous?.document ?? (previous ? await storedDocument(tx, offeringId, previous) : { version: 1, blocks: [] });
  const document = await courseDocumentForWrite(tx, offeringId, input.document, original, access, 'home');
  const title = courseDocumentTitle(document, parsed.data.title);
  return { access, exists: !!previous, document, title, revision: parsed.data.revision };
}

export async function commitCourseDocument(tx: Tx, offeringId: string, prepared: Awaited<ReturnType<typeof prepareCourseDocument>>, publish: boolean) {
  const { access, exists, document, title, revision } = prepared;
  const storedJson = document as unknown as Prisma.InputJsonValue;
  const now = new Date();
  const data = publish
    ? { title, document: storedJson, publishedAt: now, draftTitle: null, draftDocument: Prisma.DbNull, draftSavedAt: null, revision: revision + 1 }
    : { draftTitle: title, draftDocument: storedJson, draftSavedAt: now, revision: revision + 1 };
  if (exists) {
    const updated = await tx.courseFocus.updateMany({ where: { offeringId, revision }, data });
    if (updated.count !== 1) throw new DomainError('页面已更新，请保留当前编辑并重新载入最新版本。');
  } else {
    try {
      // A first draft creates no public title, text, or reference. The explicit
      // empty document also distinguishes it from legacy published body fields.
      await tx.courseFocus.create({ data: { offeringId, title: '', document: { version: 1, blocks: [] }, ...data } });
    }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new DomainError('另一位成员已创建此页面，请保留当前编辑并重新载入最新版本。');
      throw error;
    }
  }
  if (publish) {
    const references = collectCourseReferences(document);
    await tx.courseFocusAssignment.deleteMany({ where: { offeringId } });
    await tx.courseFocusResource.deleteMany({ where: { offeringId } });
    if (references.assignmentIds.length) await tx.courseFocusAssignment.createMany({ data: references.assignmentIds.map(assignmentId => ({ offeringId, assignmentId })) });
    if (references.resourceIds.length) await tx.courseFocusResource.createMany({ data: references.resourceIds.map(resourceId => ({ offeringId, resourceId })) });
  }
  return (await readFocus(tx, offeringId, access))!;
}

/** Trusted service callers publish directly. HTTP actions use the checked publication entry point below. */
export async function saveCourseDocumentInTransaction(tx: Tx, userId: string, offeringId: string, input: CourseDocumentInput): Promise<CourseFocusContent> {
  const prepared = await prepareCourseDocument(tx, userId, offeringId, input);
  return commitCourseDocument(tx, offeringId, prepared, true);
}

export async function saveCourseDocument(userId: string, offeringId: string, input: CourseDocumentInput): Promise<CourseFocusContent> {
  return transaction(tx => saveCourseDocumentInTransaction(tx, userId, offeringId, input));
}

export async function saveCourseDocumentDraft(userId: string, offeringId: string, input: CourseDocumentInput): Promise<CourseFocusContent> {
  return transaction(async tx => {
    const prepared = await prepareCourseDocument(tx, userId, offeringId, input);
    return commitCourseDocument(tx, offeringId, prepared, false);
  });
}

type FocusPublicationResult =
  | { focus: CourseFocusContent; summary: CoursePublicationSummary; review?: never }
  | { review: CoursePublicationSummary; focus?: never; summary?: never };

export async function publishCourseDocument(userId: string, offeringId: string, input: CourseDocumentInput, acknowledgedVisibility?: string): Promise<FocusPublicationResult> {
  return transaction(async tx => {
    const prepared = await prepareCourseDocument(tx, userId, offeringId, input);
    const visible = await courseDocumentForReader(tx, offeringId, prepared.document, prepared.access, true, { forPublication: true });
    const decision = await checkCoursePagePublication(tx, offeringId, visible, acknowledgedVisibility);
    if (decision.review) return { review: decision.review };
    const focus = await commitCourseDocument(tx, offeringId, prepared, true);
    return { focus, summary: decision.summary };
  });
}

export async function withdrawCourseDocument(userId: string, offeringId: string, revision: number): Promise<CourseFocusContent> {
  return transaction(async tx => {
    const access = await focusAccess(tx, userId, offeringId, true);
    z.number().int().min(0).parse(revision);
    const previous = await storedFocus(tx, offeringId);
    if (!previous?.publishedAt) throw new DomainError('此页面目前没有已发布的正文。');
    if (previous.revision !== revision) throw new DomainError('另一位成员已更新此页面，请重新载入后再撤回。');
    // Read the original storage, not the TA projection. This preserves inaccessible
    // records, including legacy pages whose references still live in the join tables.
    const draft = previous.draftDocument === null
      ? { draftTitle: previous.title, draftDocument: await storedDocument(tx, offeringId, previous) as unknown as Prisma.InputJsonValue, draftSavedAt: new Date() }
      : {};
    const updated = await tx.courseFocus.updateMany({
      where: { offeringId, revision, publishedAt: { not: null } },
      data: { ...draft, publishedAt: null, title: '', body: '', document: { version: 1, blocks: [] }, revision: { increment: 1 } },
    });
    if (updated.count !== 1) throw new DomainError('页面已更新，请重新载入后再撤回。');
    await tx.courseFocusAssignment.deleteMany({ where: { offeringId } });
    await tx.courseFocusResource.deleteMany({ where: { offeringId } });
    return (await readFocus(tx, offeringId, access))!;
  });
}

export { transaction as courseDocumentTransaction, focusAccess as coursePageAccess };
