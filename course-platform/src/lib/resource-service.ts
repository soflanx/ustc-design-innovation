import { createHash } from 'node:crypto';
import { Prisma, type ContentStatus } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { DomainError } from './management';
import { canManageOffering, canViewOffering } from './policy';
import { legacyResourceFilename, readResourceUpload } from './resource-file';

function isResourceLink(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

const resourceInput = z.object({
  title: z.string().trim().min(1, '请填写资料标题。').max(100, '标题请控制在 100 字以内。'),
  body: z.string().trim().max(12000, '资料说明请控制在 12000 字以内。'),
  url: z.string().trim().max(2000, '链接过长。').refine(value => !value || isResourceLink(value), '请填写完整的 http 或 https 链接，不要包含账号密码。'),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']),
});

export type ResourceInput = z.input<typeof resourceInput> & { file?: File };
const fileMetadata = { file: { select: { name: true, size: true } } } as const;
type ResourceWithFile = Prisma.ResourceGetPayload<{ include: typeof fileMetadata }>;

export class ResourceRevisionConflictError extends DomainError {
  constructor() { super('资料已被更新，请重新载入最新内容后保存；当前修改未覆盖。'); }
}

async function resourceAccess(client: Prisma.TransactionClient, userId: string, offeringId: string, write = false) {
  const user = await client.user.findUnique({ where: { id: userId } });
  const offering = await client.courseOffering.findUnique({ where: { id: offeringId } });
  const member = await client.courseMember.findUnique({ where: { offeringId_userId: { offeringId, userId } } });
  if (!user || !offering || !canViewOffering(user.isAdmin, member)) throw new DomainError('你没有访问这门课程资料的权限。');
  const canManage = canManageOffering(user.isAdmin, member);
  if (write && !canManage) throw new DomainError('只有本期教师或管理员可以发布课程资料。');
  if (write && offering.status === 'ARCHIVED') throw new DomainError('已归档学期的资料保持只读。');
  return { canManage, offering };
}

async function transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, retryUnique = false): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || (retryUnique && error.code === 'P2002')) && attempt < 2) continue;
      throw error;
    }
  }
  throw new DomainError('资料正在更新，请重试。');
}

/** Keep authorization and validation identical for page and list management. */
function resourceView({ creationRequestId: _request, creationFingerprint: _fingerprint, creatorId: _creator, ...resource }: ResourceWithFile) { return resource; }

export async function writeResourceInTransaction(tx: Prisma.TransactionClient, userId: string, offeringId: string, input: ResourceInput, resourceId?: string, expectedRevision?: number, requestId?: string) {
  await resourceAccess(tx, userId, offeringId, true);
  const values = resourceInput.parse(input);
  const file = await readResourceUpload(input.file);
  if (file) values.url = '';
  if (!resourceId) {
    if (!file && !values.body && !values.url) throw new DomainError('请选择文件，或填写资料链接。');
    if (requestId !== undefined && !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(requestId)) throw new DomainError('创建标识无效，请重新打开新建窗口。');
    const key = requestId?.toLowerCase() ?? null;
    const hash = createHash('sha256').update(JSON.stringify(values));
    // Preserve existing creation keys for callers that previously sent only text.
    if (file) hash.update(JSON.stringify([file.name, file.size])).update(file.bytes);
    const fingerprint = hash.digest('hex');
    if (key) {
      const existing = await tx.resource.findUnique({ where: { creationRequestId: key }, include: fileMetadata });
      if (existing) {
        if (existing.creatorId !== userId || existing.offeringId !== offeringId || existing.creationFingerprint !== fingerprint) throw new DomainError('创建标识已被其他内容使用，请重新打开新建窗口。');
        return resourceView(existing);
      }
    }
    return resourceView(await tx.resource.create({ data: { ...values, url: values.url || null, offeringId, visibility: 'OFFERING', creatorId: userId,
      creationRequestId: key, creationFingerprint: key ? fingerprint : null, firstPublishedAt: values.status === 'PUBLISHED' ? new Date() : null,
      file: file ? { create: file } : undefined }, include: fileMetadata }));
  }
  const existing = await tx.resource.findFirst({ where: { id: resourceId, offeringId }, include: fileMetadata });
  if (!existing) throw new DomainError('资料不存在或不属于本学期。');
  if (!Number.isInteger(expectedRevision) || expectedRevision! < 1) throw new DomainError('请重新打开资料后保存，缺少有效的资料版本。');
  if (existing.revision !== expectedRevision) throw new ResourceRevisionConflictError();
  if (!existing.file && !file && !values.body && !values.url) throw new DomainError('请选择文件，或填写资料链接。');
  const changed = await tx.resource.updateMany({ where: { id: existing.id, offeringId, revision: expectedRevision },
    data: { ...values, url: values.url || null, visibility: 'OFFERING', revision: { increment: 1 },
      firstPublishedAt: existing.firstPublishedAt ?? (existing.status !== 'PUBLISHED' && values.status === 'PUBLISHED' ? new Date() : null) } });
  if (changed.count !== 1) throw new ResourceRevisionConflictError();
  if (file) await tx.resourceFile.upsert({ where: { resourceId }, create: { resourceId, ...file }, update: file, select: { resourceId: true } });
  else if (existing.file && values.url) await tx.resourceFile.delete({ where: { resourceId }, select: { resourceId: true } });
  return resourceView(await tx.resource.findUniqueOrThrow({ where: { id: existing.id }, include: fileMetadata }));
}

export async function createResource(userId: string, offeringId: string, input: ResourceInput, requestId?: string) {
  return transaction(tx => writeResourceInTransaction(tx, userId, offeringId, input, undefined, undefined, requestId), true);
}

export async function updateResource(userId: string, offeringId: string, resourceId: string, input: ResourceInput, expectedRevision: number) {
  return transaction(tx => writeResourceInTransaction(tx, userId, offeringId, input, resourceId, expectedRevision));
}

/** Release a reviewed draft without replacing its metadata or file. */
export async function publishResourceDraftInTransaction(tx: Prisma.TransactionClient, userId: string, offeringId: string, resourceId: string, revision: number) {
  await resourceAccess(tx, userId, offeringId, true);
  const existing = await tx.resource.findFirst({
    where: { id: resourceId, offeringId, status: 'DRAFT', revision },
    select: { firstPublishedAt: true },
  });
  if (!existing) throw new ResourceRevisionConflictError();
  const changed = await tx.resource.updateMany({
    where: { id: resourceId, offeringId, status: 'DRAFT', revision },
    data: { status: 'PUBLISHED', firstPublishedAt: existing.firstPublishedAt ?? new Date(), revision: { increment: 1 } },
  });
  if (changed.count !== 1) throw new ResourceRevisionConflictError();
}

export async function changeResourceStatus(userId: string, offeringId: string, resourceId: string, input: { status: ContentStatus; expectedRevision: number }) {
  return transaction(async tx => {
    await resourceAccess(tx, userId, offeringId, true);
    const existing = await tx.resource.findFirst({ where: { id: resourceId, offeringId } });
    if (!existing) throw new DomainError('资料不存在或不属于本学期。');
    return writeResourceInTransaction(tx, userId, offeringId, { ...existing, url: existing.url ?? '', status: input.status }, resourceId, input.expectedRevision);
  });
}

export async function getCourseResources(userId: string, offeringId: string) {
  const access = await resourceAccess(db, userId, offeringId);
  const resources = await db.resource.findMany({
    where: { offeringId, ...(access.canManage ? {} : { status: 'PUBLISHED' }) },
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
    include: fileMetadata,
  });
  return { ...access, resources: resources.map(resourceView) };
}

export async function getCourseResourceReferences(userId: string, offeringId: string, resourceIds: string[]) {
  const { canManage } = await resourceAccess(db, userId, offeringId);
  return db.resource.findMany({
    where: { offeringId, id: { in: resourceIds }, ...(canManage ? {} : { status: 'PUBLISHED' }) },
    select: { id: true, offeringId: true, url: true, file: { select: { name: true } } },
  });
}

export async function getCourseResource(userId: string, offeringId: string, resourceId: string) {
  const access = await resourceAccess(db, userId, offeringId);
  const resource = await db.resource.findFirst({
    where: { id: resourceId, offeringId, ...(access.canManage ? {} : { status: 'PUBLISHED' }) },
    include: fileMetadata,
  });
  return { ...access, resource: resource ? resourceView(resource) : null };
}

export type CourseResourceFile = { name: string; bytes: Uint8Array } | { url: string };

export async function getCourseResourceFile(userId: string, offeringId: string, resourceId: string): Promise<CourseResourceFile | null> {
  return transaction(async tx => {
    const { canManage } = await resourceAccess(tx, userId, offeringId);
    const record = await tx.resource.findFirst({
      where: { id: resourceId, offeringId, ...(canManage ? {} : { status: 'PUBLISHED' }) },
      select: { title: true, url: true, body: true, file: { select: { name: true, bytes: true } } },
    });
    if (!record) return null;
    if (record.file) return record.file;
    if (record.url && isResourceLink(record.url)) return { url: new URL(record.url).href };
    return { name: legacyResourceFilename(record.title), bytes: new TextEncoder().encode(record.body) };
  });
}
