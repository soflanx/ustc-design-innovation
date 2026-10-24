import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { DomainError } from './management';
import { canManageOffering, canViewOffering } from './policy';

const focusInput = z.object({
  title: z.string().trim().min(1, '请填写当前教学内容的标题。').max(100, '标题请控制在 100 字以内。'),
  body: z.string().trim().max(12000, '教学说明请控制在 12000 字以内。'),
  assignmentIds: z.array(z.string().min(1).max(200)).max(500, '关联作业过多。'),
  resourceIds: z.array(z.string().min(1).max(200)).max(500, '关联资料过多。'),
});

export type CourseFocusInput = z.input<typeof focusInput>;
export type CourseFocusContent = {
  title: string;
  body: string;
  assignmentIds: string[];
  resourceIds: string[];
  updatedAt: Date;
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
    readAllAssignments: staff,
    // Focus editing does not grant a TA access to draft or withdrawn materials.
    readAllResources: canManageOffering(user.isAdmin, member),
  };
}

async function transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 2) continue;
      throw error;
    }
  }
  throw new DomainError('教学内容正在更新，请重试。');
}

async function readFocus(client: Tx, offeringId: string, access: Awaited<ReturnType<typeof focusAccess>>): Promise<CourseFocusContent | null> {
  const focus = await client.courseFocus.findUnique({
    where: { offeringId },
    include: {
      assignments: {
        where: access.readAllAssignments ? {} : { assignment: { status: { in: ['PUBLISHED', 'ARCHIVED'] } } },
        select: { assignmentId: true },
        orderBy: { assignmentId: 'asc' },
      },
      resources: {
        where: access.readAllResources ? {} : { resource: { status: 'PUBLISHED' } },
        select: { resourceId: true },
        orderBy: { resourceId: 'asc' },
      },
    },
  });
  return focus ? {
    title: focus.title,
    body: focus.body,
    assignmentIds: focus.assignments.map(link => link.assignmentId),
    resourceIds: focus.resources.map(link => link.resourceId),
    updatedAt: focus.updatedAt,
  } : null;
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

    await tx.courseFocus.upsert({
      where: { offeringId }, create: { offeringId, title, body }, update: { title, body },
    });
    await tx.courseFocusAssignment.deleteMany({ where: { offeringId } });
    await tx.courseFocusResource.deleteMany({ where: { offeringId } });
    if (assignmentIds.length) await tx.courseFocusAssignment.createMany({ data: assignmentIds.map(assignmentId => ({ offeringId, assignmentId })) });
    if (nextResourceIds.length) await tx.courseFocusResource.createMany({ data: nextResourceIds.map(resourceId => ({ offeringId, resourceId })) });
    return (await readFocus(tx, offeringId, access))!;
  });
}
