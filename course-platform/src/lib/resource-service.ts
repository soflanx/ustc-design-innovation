import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { DomainError } from './management';
import { canManageOffering, canViewOffering } from './policy';

const resourceInput = z.object({
  title: z.string().trim().min(1, '请填写资料标题。').max(100, '标题请控制在 100 字以内。'),
  body: z.string().trim().max(12000, '资料说明请控制在 12000 字以内。'),
  url: z.string().trim().max(2000, '链接过长。').refine(value => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }, '请填写完整的 http 或 https 链接，不要包含账号密码。'),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']),
}).refine(value => !!value.body || !!value.url, '请填写资料说明或资料链接。');

export type ResourceInput = z.input<typeof resourceInput>;

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

async function transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 2) continue;
      throw error;
    }
  }
  throw new DomainError('资料正在更新，请重试。');
}

export async function createResource(userId: string, offeringId: string, input: ResourceInput) {
  return transaction(async tx => {
    await resourceAccess(tx, userId, offeringId, true);
    const values = resourceInput.parse(input);
    return tx.resource.create({ data: { ...values, url: values.url || null, offeringId, visibility: 'OFFERING' } });
  });
}

export async function updateResource(userId: string, offeringId: string, resourceId: string, input: ResourceInput) {
  return transaction(async tx => {
    await resourceAccess(tx, userId, offeringId, true);
    const existing = await tx.resource.findFirst({ where: { id: resourceId, offeringId } });
    if (!existing) throw new DomainError('资料不存在或不属于本学期。');
    const values = resourceInput.parse(input);
    return tx.resource.update({ where: { id: existing.id }, data: { ...values, url: values.url || null, visibility: 'OFFERING' } });
  });
}

export async function getCourseResources(userId: string, offeringId: string) {
  const access = await resourceAccess(db, userId, offeringId);
  const resources = await db.resource.findMany({
    where: { offeringId, ...(access.canManage ? {} : { status: 'PUBLISHED' }) },
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
  });
  return { ...access, resources };
}

export async function getCourseResource(userId: string, offeringId: string, resourceId: string) {
  const access = await resourceAccess(db, userId, offeringId);
  const resource = await db.resource.findFirst({
    where: { id: resourceId, offeringId, ...(access.canManage ? {} : { status: 'PUBLISHED' }) },
  });
  return { ...access, resource };
}
