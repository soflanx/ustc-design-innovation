import { Prisma, type MemberRole, type TermStatus } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { groupWorkHref } from './group-work-link';
import { DomainError } from './management';
import { displayDate } from './policy';
import { inlineFile } from './resource-preview';
import { storedFileFromRow, storedFileSelect, type StoredFile } from './stored-file';
import {
  showcaseDraftLimits, showcaseMaterialHref, showcasePublicationToken, showcaseSelectionKey,
  type ShowcaseDraft, type ShowcaseListing, type ShowcasePublicationStatus, type ShowcaseScope,
  type ShowcaseSelection, type ShowcaseSource, type ShowcaseStory, type ShowcaseWorkspace,
} from './group-showcase-contract';

type Tx = Prisma.TransactionClient;
type DraftRecord = ShowcaseDraft & { revision: number };

export class GroupShowcaseDraftConflictError extends DomainError {
  constructor(readonly current: DraftRecord, readonly sources: ShowcaseSource[]) {
    super('展示草稿已有更新，请核对最新稿后再保存。');
    this.name = 'GroupShowcaseDraftConflictError';
  }
}

export class GroupShowcaseMaterialsError extends DomainError {
  constructor(readonly selectionKeys: string[]) {
    super('部分选材已无法读取，请移除或重新选取后再继续。');
    this.name = 'GroupShowcaseMaterialsError';
  }
}

const idInput = z.string().min(1).max(200).refine(id => !id.includes('\0') && id.isWellFormed());
const textInput = (max: number) => z.string().trim().max(max).refine(value => !value.includes('\0') && value.isWellFormed());
const scopeInput = z.enum(['CLASS', 'PUBLIC']);
const revisionInput = z.number().int().min(0).max(2147483646);
const selectionInput = z.object({
  source: z.enum(['ACTIVITY', 'SUBMISSION']),
  sourceId: idInput,
  fileId: idInput.nullable(),
  caption: textInput(showcaseDraftLimits.caption),
});
const draftInput = z.object({
  title: textInput(showcaseDraftLimits.title),
  summary: textInput(showcaseDraftLimits.summary),
  body: textInput(showcaseDraftLimits.body),
  selections: z.array(selectionInput).max(showcaseDraftLimits.materials)
    .refine(items => new Set(items.map(showcaseSelectionKey)).size === items.length),
});
const publicationStatusSelect = { id: true, draftRevision: true, publishedAt: true, withdrawnAt: true } as const;
const draftSelect = { revision: true, title: true, summary: true, body: true, selections: true } as const;
async function listSources(tx: Tx, offeringId: string, groupId: string, selections?: ShowcaseSelection[]): Promise<ShowcaseSource[]> {
  if (selections?.length === 0) return [];
  const chosen = (kind: ShowcaseSelection['source']) => selections
    ? { in: [...new Set(selections.filter(item => item.source === kind).map(item => item.sourceId))] }
    : undefined;
  const activityIds = chosen('ACTIVITY');
  const versionIds = chosen('SUBMISSION');
  const groupHref = groupWorkHref(offeringId, undefined, groupId);
  const acts = await tx.groupActivity.findMany({
    where: { offeringId, groupId, withdrawnAt: null, id: activityIds },
    select: {
      id: true, body: true, nextStep: true, occurredOn: true, createdAt: true,
      files: { orderBy: { position: 'asc' }, select: { fileId: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const versions = await tx.submissionVersion.findMany({
    where: {
      id: versionIds, offeringId, finalizedAt: { not: null },
      submission: { groupId, assignment: { mode: 'GROUP', status: { in: ['PUBLISHED', 'ARCHIVED', 'CANCELLED'] } } },
    },
    select: {
      id: true, body: true, version: true,
      assignmentRevision: { select: { title: true } },
      submission: { select: { assignmentId: true, assignment: { select: { title: true } } } },
      files: { orderBy: [{ file: { createdAt: 'asc' } }, { fileId: 'asc' }], select: { fileId: true } },
    },
    orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
  });
  const selectedFiles = selections
    ? new Set(selections.flatMap(item => item.fileId === null ? [] : [item.fileId]))
    : null;
  const ids = [...new Set([...acts, ...versions].flatMap(row => row.files
    .map(({ fileId }) => fileId).filter(fileId => !selectedFiles || selectedFiles.has(fileId))))];
  // The editor needs file names and signatures only, regardless of upload size.
  const headers = ids.length ? await tx.$queryRaw<{ id: string; name: string; header: Uint8Array }[]>(Prisma.sql`
    SELECT f."id", f."originalName" AS "name",
      substring(CASE WHEN f."chunked" THEN c."bytes" ELSE f."bytes" END FROM 1 FOR 16) AS "header"
    FROM "FileObject" AS f
    LEFT JOIN "FileObjectChunk" AS c ON c."fileId" = f."id" AND c."index" = 0
    WHERE f."offeringId" = ${offeringId} AND f."id" IN (${Prisma.join(ids)})
      AND (CASE WHEN f."chunked" THEN c."bytes" ELSE f."bytes" END) IS NOT NULL
    ORDER BY f."id" ${selections ? Prisma.sql`FOR SHARE OF f` : Prisma.empty}
  `) : [];
  const headerById = new Map(headers.map(file => [file.id, file]));
  function files(source: { files: { fileId: string }[] }, fileBase: string): ShowcaseSource['files'] {
    return source.files.flatMap(({ fileId }) => {
      const file = headerById.get(fileId);
      if (!file) return [];
      return [{
        id: file.id, name: file.name, image: inlineFile(file.name, file.header)?.kind === 'image',
        href: `${fileBase}/${encodeURIComponent(file.id)}`,
      }];
    });
  }
  return [
    ...acts.map((activity): ShowcaseSource => ({
      id: activity.id, source: 'ACTIVITY',
      label: `过程记录 · ${displayDate(activity.occurredOn ?? activity.createdAt)}${activity.occurredOn ? '' : '保存'}`,
      body: [activity.body, activity.nextStep && `下一步 ${activity.nextStep}`].filter(Boolean).join('\n\n'),
      href: `${groupHref}#activity-${encodeURIComponent(activity.id)}`,
      files: files(activity, `${groupHref}/activities/${encodeURIComponent(activity.id)}/files`),
    })),
    ...versions.map((version): ShowcaseSource => {
      const href = `/courses/${encodeURIComponent(offeringId)}/assignments/${encodeURIComponent(version.submission.assignmentId)}/submissions/${encodeURIComponent(version.id)}`;
      return { id: version.id, source: 'SUBMISSION',
        label: `${version.assignmentRevision?.title ?? version.submission.assignment.title} · 第 ${version.version} 版`,
        body: version.body, href, files: files(version, `${href}/files`),
      };
    }),
  ];
}

function selectedMaterials(sources: ShowcaseSource[], selections: ShowcaseSelection[]) {
  const bySource = new Map(sources.map(source => [JSON.stringify([source.source, source.id]), source]));
  const materials = [];
  const unavailable = [];
  for (const [position, selection] of selections.entries()) {
    const source = bySource.get(JSON.stringify([selection.source, selection.sourceId]));
    const file = selection.fileId === null ? null : source?.files.find(file => file.id === selection.fileId);
    if (!source || (selection.fileId === null ? !source.body.trim() : !file)) {
      unavailable.push(showcaseSelectionKey(selection));
      continue;
    }
    materials.push({
      position, caption: selection.caption, sourceLabel: source.label,
      activityId: source.source === 'ACTIVITY' ? source.id : null,
      versionId: source.source === 'SUBMISSION' ? source.id : null,
      text: file ? null : source.body,
      fileId: file?.id ?? null, fileName: file?.name ?? null, image: file?.image ?? false,
    });
  }
  if (unavailable.length) throw new GroupShowcaseMaterialsError(unavailable);
  return materials;
}

function readDraft(record: { title: string; summary: string; body: string; selections: Prisma.JsonValue; revision: number }): DraftRecord {
  return { ...record, selections: z.array(selectionInput).parse(record.selections) };
}

export async function getGroupShowcaseWorkspace(userId: string, offeringId: string, groupId: string): Promise<ShowcaseWorkspace | null> {
  return db.$transaction(async tx => {
    const enrolled = { userId, status: 'ACTIVE' as const };
    const group = await tx.group.findFirst({
      where: { id: groupId, offeringId, offering: { members: { some: {
        ...enrolled, OR: [
          { role: { in: ['TEACHER', 'TA'] } },
          { role: 'STUDENT', groupMemberships: { some: { offeringId, groupId, leftAt: null } } },
        ],
      } } } },
      select: {
        name: true, page: { select: { title: true } }, showcaseDraft: { select: draftSelect },
        offering: { select: { status: true, members: { where: enrolled, select: { role: true }, take: 1 } } },
      },
    });
    if (!group) return null;
    const [member] = group.offering.members;
    const teaching = member.role === 'TEACHER' || member.role === 'TA';
    const active = group.offering.status === 'ACTIVE';
    const lastPublications = await tx.groupShowcasePublication.findMany({
      where: { offeringId, groupId }, distinct: ['scope'], orderBy: { sequence: 'desc' },
      select: { ...publicationStatusSelect, scope: true },
    });
    const publications: Record<ShowcaseScope, ShowcasePublicationStatus | null> = { CLASS: null, PUBLIC: null };
    for (const { scope, ...publication } of lastPublications) publications[scope] = publication;
    return {
      groupName: group.name, projectTitle: group.page?.title || group.name,
      draft: group.showcaseDraft ? readDraft(group.showcaseDraft) : null,
      sources: await listSources(tx, offeringId, groupId), publications,
      canEdit: active && member.role === 'STUDENT', canPublish: active && teaching,
      canWithdraw: teaching && group.offering.status !== 'DRAFT',
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

async function lockShowcaseWriter(tx: Tx, userId: string, offeringId: string, groupId: string, operation: 'edit' | 'publish' | 'withdraw') {
  // Take the offering before the group. A non-key group lock serializes draft
  // and review decisions without blocking foreign keys in other group work.
  const [offering] = await tx.$queryRaw<{ status: TermStatus }[]>`
    SELECT "status" FROM "CourseOffering" WHERE "id" = ${offeringId} FOR SHARE
  `;
  if (!offering) throw new DomainError('本期开课不存在。');
  if (offering.status !== 'ACTIVE' && !(operation === 'withdraw' && offering.status === 'ARCHIVED')) {
    throw new DomainError('课程当前不开放这项展示操作。');
  }
  const [group] = await tx.$queryRaw<{ name: string }[]>`
    SELECT "name" FROM "Group" WHERE "id" = ${groupId} AND "offeringId" = ${offeringId} FOR NO KEY UPDATE
  `;
  if (!group) throw new DomainError('本期小组不存在。');
  const [member] = await tx.$queryRaw<{ id: string; role: MemberRole }[]>`
    SELECT "id", "role" FROM "CourseMember" WHERE "userId" = ${userId} AND "offeringId" = ${offeringId} AND "status" = 'ACTIVE' FOR SHARE
  `;
  if (operation === 'edit') {
    if (member?.role !== 'STUDENT') throw new DomainError('只有本组当前组员可以整理展示。');
    const [membership] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "GroupMember" WHERE "offeringId" = ${offeringId} AND "groupId" = ${groupId}
        AND "courseMemberId" = ${member.id} AND "leftAt" IS NULL FOR SHARE
    `;
    if (!membership) throw new DomainError('你的组籍已经变化，请从当前小组整理展示。');
  } else if (member?.role !== 'TA' && member?.role !== 'TEACHER') {
    throw new DomainError('只有本期教学团队可以确认或撤回展示。');
  }
  return { groupName: group.name, memberId: member.id };
}

export async function saveGroupShowcaseDraft(userId: string, offeringId: string, groupId: string, expectedRevision: number, draft: ShowcaseDraft): Promise<DraftRecord> {
  const input = draftInput.safeParse(draft);
  if (!input.success || !revisionInput.safeParse(expectedRevision).success) {
    throw new DomainError('请核对草稿版本、文字长度和选材数量。');
  }
  return db.$transaction(async tx => {
    await lockShowcaseWriter(tx, userId, offeringId, groupId, 'edit');
    const { title, summary, body, selections } = input.data;
    const stored = await tx.groupShowcaseDraft.findUnique({ where: { groupId }, select: draftSelect });
    const current = stored && readDraft(stored);
    if (current && (current.revision === expectedRevision || current.revision === expectedRevision + 1)
      && current.title === title && current.summary === summary && current.body === body
      && JSON.stringify(current.selections) === JSON.stringify(selections)) return current;
    if ((current?.revision ?? 0) !== expectedRevision) {
      // Return the comparison only after checking current group membership.
      if (current) throw new GroupShowcaseDraftConflictError(current, await listSources(tx, offeringId, groupId));
      throw new DomainError('当前展示草稿已变化。请保留编辑，在新标签核对当前草稿。');
    }
    selectedMaterials(await listSources(tx, offeringId, groupId, selections), selections);
    const revision = expectedRevision + 1;
    await tx.groupShowcaseDraft.upsert({
      where: { groupId }, create: { offeringId, groupId, title, summary, body, selections, revision },
      update: { title, summary, body, selections, revision },
    });
    return { title, summary, body, selections, revision };
  });
}

async function latestPublication(tx: Tx, offeringId: string, groupId: string, scope: ShowcaseScope) {
  return tx.groupShowcasePublication.findFirst({
    where: { offeringId, groupId, scope }, orderBy: { sequence: 'desc' },
    select: { ...publicationStatusSelect, sequence: true },
  });
}

export async function publishGroupShowcase(userId: string, offeringId: string, groupId: string, scope: ShowcaseScope, expectedRevision: number, expectedPublicationToken: string | null): Promise<void> {
  if (!scopeInput.safeParse(scope).success || !revisionInput.safeParse(expectedRevision).success) {
    throw new DomainError('请重新打开展示预览，核对待确认的版本和范围。');
  }
  await db.$transaction(async tx => {
    const { groupName, memberId } = await lockShowcaseWriter(tx, userId, offeringId, groupId, 'publish');
    const current = await latestPublication(tx, offeringId, groupId, scope);
    if (showcasePublicationToken(current) !== expectedPublicationToken) {
      throw new DomainError('这个分享范围已有更新，请刷新页面重新核对。');
    }
    const record = await tx.groupShowcaseDraft.findUnique({ where: { groupId }, select: draftSelect });
    if (!record || record.revision !== expectedRevision) throw new DomainError('展示草稿已有更新，请查看新版再确认。');
    if (!record.title || !record.body) throw new DomainError('请先填写项目标题和正文。');
    const { title, summary, body, selections, revision } = readDraft(record);
    const activities = [...new Set(selections.filter(selection => selection.source === 'ACTIVITY').map(selection => selection.sourceId))];
    if (activities.length) await tx.$queryRaw`
      SELECT "id" FROM "GroupActivity" WHERE "offeringId" = ${offeringId} AND "groupId" = ${groupId}
        AND "id" IN (${Prisma.join(activities)}) ORDER BY "id" FOR SHARE
    `;
    const materials = selectedMaterials(await listSources(tx, offeringId, groupId, selections), selections);
    const now = new Date();
    if (current && !current.withdrawnAt) {
      await tx.groupShowcasePublication.update({ where: { id: current.id }, data: { supersededAt: now } });
    }
    const publication = await tx.groupShowcasePublication.create({
      data: { offeringId, groupId, scope, sequence: (current?.sequence ?? 0) + 1, draftRevision: revision,
        title, summary, body, groupName, publisherId: memberId, publishedAt: now },
      select: { id: true },
    });
    if (materials.length) await tx.groupShowcaseMaterial.createMany({
      data: materials.map(material => ({ ...material, offeringId, publicationId: publication.id })),
    });
  });
}

export async function withdrawGroupShowcase(userId: string, offeringId: string, groupId: string, scope: ShowcaseScope, expectedPublicationId: string): Promise<void> {
  if (!scopeInput.safeParse(scope).success) throw new DomainError('请核对要撤回的展示范围。');
  await db.$transaction(async tx => {
    const { memberId } = await lockShowcaseWriter(tx, userId, offeringId, groupId, 'withdraw');
    const current = await latestPublication(tx, offeringId, groupId, scope);
    if (!current || current.id !== expectedPublicationId) throw new DomainError('这个分享范围已有更新，请刷新页面重新核对。');
    if (!current.withdrawnAt) {
      await tx.groupShowcasePublication.update({
        where: { id: current.id }, data: { withdrawnAt: new Date(), withdrawnById: memberId },
      });
    }
  });
}

const currentPublication = { withdrawnAt: null, supersededAt: null } as const;

function publicPublication(offeringId?: string): Prisma.GroupShowcasePublicationWhereInput {
  return {
    ...currentPublication, offeringId, scope: 'PUBLIC',
    group: { offering: { status: { in: ['ACTIVE', 'ARCHIVED'] } } },
  };
}

function visiblePublication(offeringId: string, scope: ShowcaseScope, userId?: string): Prisma.GroupShowcasePublicationWhereInput | null {
  if (scope === 'PUBLIC') return publicPublication(offeringId);
  if (scope !== 'CLASS' || !userId) return null;
  return {
    ...currentPublication, offeringId, scope,
    group: { offering: { members: { some: { userId, status: 'ACTIVE' } } } },
  };
}

export async function listPublicShowcaseProjects(take?: number) {
  const rows = await db.groupShowcasePublication.findMany({
    where: publicPublication(), take,
    orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true, groupId: true, offeringId: true, title: true, summary: true, publishedAt: true,
      group: { select: { offering: { select: {
        term: { select: { id: true, name: true, startDate: true } },
      } } } },
      materials: {
        where: { image: true }, orderBy: { position: 'asc' }, take: 1,
        select: { id: true, caption: true, fileName: true },
      },
    },
  });
  return rows.map(({ id, group, materials: [image], ...project }) => ({
    ...project,
    term: group.offering.term,
    cover: image ? {
      src: showcaseMaterialHref(project.offeringId, project.groupId, 'PUBLIC', id, image.id),
      alt: image.caption || image.fileName || project.title,
    } : null,
  }));
}

export async function listPublishedGroupShowcases(offeringId: string, scope: ShowcaseScope, userId?: string): Promise<ShowcaseListing[]> {
  const where = visiblePublication(offeringId, scope, userId);
  if (!where) return [];
  return db.groupShowcasePublication.findMany({
    where, select: { groupId: true, groupName: true, title: true, summary: true },
    orderBy: [{ groupName: 'asc' }, { groupId: 'asc' }],
  });
}

export async function getPublishedGroupShowcase(offeringId: string, groupId: string, scope: ShowcaseScope, userId?: string): Promise<ShowcaseStory | null> {
  const where = visiblePublication(offeringId, scope, userId);
  if (!where) return null;
  const story = await db.groupShowcasePublication.findFirst({
    where: { ...where, groupId },
    select: {
      id: true, title: true, summary: true, body: true, groupName: true,
      materials: { orderBy: { position: 'asc' }, select: {
        id: true, caption: true, sourceLabel: true, text: true, fileName: true, image: true,
      } },
    },
  });
  if (!story) return null;
  const { id, materials, ...text } = story;
  return { ...text, publicationId: id, materials: materials.map(({ fileName, image, ...material }) => ({
    ...material, file: fileName === null ? null : { name: fileName, image },
  })) };
}

export async function getPublishedGroupShowcaseFile(
  offeringId: string, groupId: string, scope: ShowcaseScope, publicationId: string, materialId: string, userId?: string,
): Promise<StoredFile | null> {
  const where = visiblePublication(offeringId, scope, userId);
  if (!where) return null;
  const material = await db.groupShowcaseMaterial.findFirst({
    where: { id: materialId, offeringId, publicationId, fileId: { not: null }, publication: { ...where, groupId } },
    select: { fileName: true, file: { select: storedFileSelect } },
  });
  if (!material?.fileName || !material.file) return null;
  const file = storedFileFromRow(material.file);
  return file ? { ...file, name: material.fileName } : null;
}
