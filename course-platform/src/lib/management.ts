import { Prisma, type MemberRole, type TermStatus } from '@prisma/client';
import { db } from './db';
import { canManageOffering, canViewGroup } from './policy';

export class DomainError extends Error {}

type Tx = Prisma.TransactionClient;

async function transactional<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 2) continue;
      throw error;
    }
  }
  throw new DomainError('数据正在更新，请重试。');
}

async function offeringManager(tx: Tx, userId: string, offeringId: string, allowArchived = false) {
  const user = await tx.user.findUnique({ where: { id: userId } });
  const offering = await tx.courseOffering.findUnique({ where: { id: offeringId } });
  const member = await tx.courseMember.findFirst({ where: { offeringId, userId } });
  if (!user || !offering || !canManageOffering(user.isAdmin, member)) throw new DomainError('你没有管理这门课程的权限。');
  if (!allowArchived && offering.status === 'ARCHIVED') throw new DomainError('已归档学期保持只读，请先将课程重新开放。');
  return { user, offering, member };
}

export async function createOffering(userId: string, input: {
  courseId: string; termId?: string; termName?: string; startDate?: Date; endDate?: Date; description: string;
}) {
  return transactional(async tx => {
    // A transaction shares one pg connection; issue its queries sequentially.
    const user = await tx.user.findUnique({ where: { id: userId } });
    const course = await tx.course.findUnique({ where: { id: input.courseId } });
    const staff = await tx.courseStaff.findMany({ where: { courseId: input.courseId } });
    if (!user || !course || (!user.isAdmin && !staff.some(person => person.userId === user.id))) throw new DomainError('只有课程负责人或管理员可以创建新学期。');
    let term = input.termId ? await tx.term.findUnique({ where: { id: input.termId } }) : null;
    if (input.termId && !term) throw new DomainError('所选学期不存在。');
    if (!input.termId) {
      if (!input.termName || !input.startDate || !input.endDate || input.endDate <= input.startDate) throw new DomainError('请填写有效的学期名称与起止日期。');
      const slug = `${input.startDate.toISOString().slice(0, 10)}-${input.endDate.toISOString().slice(0, 10)}`;
      const existing = await tx.term.findUnique({ where: { slug } });
      term = existing ?? await tx.term.create({ data: { slug, name: input.termName, startDate: input.startDate, endDate: input.endDate } });
    }
    if (!term) throw new DomainError('请选择或创建学期。');
    if (await tx.courseOffering.findUnique({ where: { courseId_termId: { courseId: course.id, termId: term.id } } })) throw new DomainError('这门课程在所选学期已经开设，请直接进入已有课程。');
    const offering = await tx.courseOffering.create({
      data: { courseId: course.id, termId: term.id, title: `${course.title} · ${term.name}`, description: input.description, status: 'DRAFT' },
    });
    if (staff.length) await tx.courseMember.createMany({ data: staff.map(person => ({ offeringId: offering.id, userId: person.userId, role: 'TEACHER' as const })) });
    return offering;
  });
}

export async function setOfferingStatus(userId: string, offeringId: string, status: TermStatus) {
  return transactional(async tx => {
    await offeringManager(tx, userId, offeringId, true);
    return tx.courseOffering.update({ where: { id: offeringId }, data: status === 'ARCHIVED' ? {
      status, groupFormationWindowId: null, groupFormationClosesAt: null, groupFormationCapacity: null,
    } : { status } });
  });
}

export class OfferingIntroductionConflictError extends DomainError {
  constructor(readonly currentDescription: string) {
    super('本期介绍已有更新，请核对最新内容后再保存。');
  }
}

export async function saveOfferingIntroduction(userId: string, offeringId: string, expectedDescription: string, description: string) {
  return transactional(async tx => {
    const { offering } = await offeringManager(tx, userId, offeringId);
    if (typeof expectedDescription !== 'string' || typeof description !== 'string' || description.includes('\0')) {
      throw new DomainError('本期介绍格式无效，请检查文字后再保存。');
    }
    const next = description.trim();
    if (next.length > 2000) throw new DomainError('本期介绍请控制在 2000 字以内。');
    if (next === offering.description) return { description: next, status: offering.status };
    // Read and compare the exact original text inside the serializable write.
    // Legacy descriptions longer than today's limit can still be shortened.
    if (expectedDescription !== offering.description) throw new OfferingIntroductionConflictError(offering.description);
    return tx.courseOffering.update({
      where: { id: offeringId }, data: { description: next },
      select: { description: true, status: true },
    });
  });
}

export async function addCourseMember(userId: string, offeringId: string, targetUserId: string, role: MemberRole) {
  return transactional(async tx => {
    await offeringManager(tx, userId, offeringId);
    if (!await tx.user.findUnique({ where: { id: targetUserId } })) throw new DomainError('所选用户不存在。');
    if (await tx.courseMember.findUnique({ where: { offeringId_userId: { offeringId, userId: targetUserId } } })) throw new DomainError('该用户已经加入本学期，请勿重复添加。');
    return tx.courseMember.create({ data: { offeringId, userId: targetUserId, role } });
  });
}

export async function createGroup(userId: string, offeringId: string, name: string, description: string) {
  return transactional(async tx => {
    await offeringManager(tx, userId, offeringId);
    if (await tx.group.findUnique({ where: { offeringId_name: { offeringId, name } } })) throw new DomainError('本学期已有同名小组，请使用其他名称。');
    return tx.group.create({ data: { offeringId, name, description } });
  });
}

export async function moveStudentToGroup(userId: string, offeringId: string, groupId: string, courseMemberId: string) {
  return transactional(async tx => {
    await offeringManager(tx, userId, offeringId);
    const group = await tx.group.findFirst({ where: { id: groupId, offeringId } });
    const member = await tx.courseMember.findFirst({ where: { id: courseMemberId, offeringId, role: 'STUDENT', status: 'ACTIVE' } });
    if (!group || !member) throw new DomainError('请选择本学期的小组和在读学生。');
    const active = await tx.groupMember.findFirst({ where: { offeringId, courseMemberId, leftAt: null } });
    if (active?.groupId === groupId) throw new DomainError('这位学生已经在所选小组中。');
    const now = new Date();
    if (active) await tx.groupMember.update({ where: { id: active.id }, data: { leftAt: now } });
    return tx.groupMember.create({ data: { offeringId, groupId, courseMemberId, joinedAt: now } });
  });
}

export async function assignTa(userId: string, offeringId: string, groupId: string, courseMemberId: string) {
  return transactional(async tx => {
    await offeringManager(tx, userId, offeringId);
    const group = await tx.group.findFirst({ where: { id: groupId, offeringId } });
    const ta = await tx.courseMember.findFirst({ where: { id: courseMemberId, offeringId, role: 'TA', status: 'ACTIVE' } });
    if (!group || !ta) throw new DomainError('请选择本学期的小组和助教。');
    if (await tx.taGroupAssignment.findFirst({ where: { groupId, courseMemberId, endedAt: null } })) throw new DomainError('这位助教已经负责该小组。');
    return tx.taGroupAssignment.create({ data: { offeringId, groupId, courseMemberId } });
  });
}

export async function endTaAssignment(userId: string, offeringId: string, assignmentId: string) {
  return transactional(async tx => {
    await offeringManager(tx, userId, offeringId);
    const assignment = await tx.taGroupAssignment.findFirst({ where: { id: assignmentId, offeringId, endedAt: null } });
    if (!assignment) throw new DomainError('这项助教分工已结束或不存在。');
    return tx.taGroupAssignment.update({ where: { id: assignment.id }, data: { endedAt: new Date() } });
  });
}

export type GroupPageContent = { title: string; body: string; revision: number; updatedAt: string | null };
export type GroupPageHistoryEntry = { revision: number; title: string; createdAt: string; isBaseline: boolean; actorName: string | null };
export type GroupPageRevisionContent = GroupPageHistoryEntry & { body: string };

export class GroupPageConflictError extends DomainError {
  constructor(readonly current: GroupPageContent) {
    super('记录已被其他成员更新。你的编辑没有覆盖最新内容，请核对后再保存。');
    this.name = 'GroupPageConflictError';
  }
}

const groupPageSelect = { title: true, body: true, revision: true, updatedAt: true } as const;
function groupPageContent(page: { title: string; body: string; revision: number; updatedAt: Date }): GroupPageContent {
  return { title: page.title, body: page.body, revision: page.revision, updatedAt: page.updatedAt.toISOString() };
}

async function groupPageAccess(tx: Tx, userId: string, offeringId: string, groupId: string, write = false) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
  const offering = await tx.courseOffering.findUnique({ where: { id: offeringId }, select: { status: true } });
  const group = await tx.group.findFirst({ where: { id: groupId, offeringId }, select: { id: true, name: true, description: true } });
  const member = await tx.courseMember.findUnique({ where: { offeringId_userId: { offeringId, userId } }, select: { id: true, role: true, status: true } });
  const ownGroup = member?.role === 'STUDENT' && member.status === 'ACTIVE'
    ? !!await tx.groupMember.findFirst({ where: { offeringId, groupId, courseMemberId: member.id, leftAt: null }, select: { id: true } })
    : false;
  if (!user || !offering || !group || !canViewGroup(user.isAdmin, member, ownGroup)) throw new DomainError('小组不存在或你已无权查看本组记录。');
  if (write && !user.isAdmin && !ownGroup) throw new DomainError('只有本组成员或管理员可以编辑小组主页。');
  if (write && offering.status === 'ARCHIVED') throw new DomainError('已归档学期的小组主页保持只读。');
  return { group };
}

function isGroupPageWriteRace(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false;
  const value = error as Record<string, unknown>;
  return ['GROUP_PAGE_RACE', 'P2034', 'P2002', '40001', '23505'].includes(String(value.code))
    || ['40001', '23505'].includes(String(value.originalCode)) || value.kind === 'TransactionWriteConflict'
    || ['cause', 'meta', 'driverAdapterError'].some(key => isGroupPageWriteRace(value[key], depth + 1));
}

async function groupPageTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) {
      if (!isGroupPageWriteRace(error)) throw error;
      if (attempt === 4) throw new DomainError('记录正在更新，请保留当前编辑并重试。');
      // Concurrent first saves must re-read both authorization and the winning
      // record so that the loser receives the same conflict as a stale form.
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 10));
    }
  }
  throw new DomainError('记录正在更新，请保留当前编辑并重试。');
}

export async function getGroupPageHistory(userId: string, offeringId: string, groupId: string): Promise<GroupPageHistoryEntry[]> {
  return groupPageTransaction(async tx => {
    await groupPageAccess(tx, userId, offeringId, groupId);
    const history = await tx.groupPageRevision.findMany({
      where: { offeringId, groupId }, orderBy: { revision: 'desc' },
      select: { revision: true, title: true, createdAt: true, isBaseline: true, actorUserId: true },
    });
    const authors = await tx.user.findMany({ where: { id: { in: history.flatMap(row => row.actorUserId ? [row.actorUserId] : []) } }, select: { id: true, name: true } });
    const names = new Map(authors.map(author => [author.id, author.name]));
    return history.map(row => ({ revision: row.revision, title: row.title, createdAt: row.createdAt.toISOString(), isBaseline: row.isBaseline, actorName: row.actorUserId ? names.get(row.actorUserId) ?? null : null }));
  });
}

export async function getGroupPageRevision(userId: string, offeringId: string, groupId: string, revision: number): Promise<GroupPageRevisionContent> {
  return groupPageTransaction(async tx => {
    await groupPageAccess(tx, userId, offeringId, groupId);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new DomainError('请选择有效的历史版本。');
    const snapshot = await tx.groupPageRevision.findFirst({
      where: { offeringId, groupId, revision },
      select: { revision: true, title: true, body: true, createdAt: true, isBaseline: true, actorUserId: true },
    });
    if (!snapshot) throw new DomainError('此历史版本不存在或不可查看。');
    const author = snapshot.actorUserId ? await tx.user.findUnique({ where: { id: snapshot.actorUserId }, select: { name: true } }) : null;
    return { revision: snapshot.revision, title: snapshot.title, body: snapshot.body, createdAt: snapshot.createdAt.toISOString(), isBaseline: snapshot.isBaseline, actorName: author?.name ?? null };
  });
}

export async function saveGroupPage(userId: string, offeringId: string, groupId: string, title: string, body: string, expectedRevision: number): Promise<GroupPageContent> {
  return groupPageTransaction(async tx => {
    await groupPageAccess(tx, userId, offeringId, groupId, true);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('请重新打开小组记录后保存，缺少有效的记录版本。');
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 100) throw new DomainError('请填写 100 字以内的项目标题。');
    if (typeof body !== 'string' || !body.trim() || body.trim().length > 12000) throw new DomainError('请填写 12000 字以内的工作记录。');
    const current = await tx.groupPage.findFirst({ where: { offeringId, groupId }, select: groupPageSelect });
    if ((current?.revision ?? 0) !== expectedRevision) {
      // Content is included only after the actor's current group and write
      // access were checked; former group members never receive this payload.
      if (current) throw new GroupPageConflictError(groupPageContent(current));
      throw new DomainError('小组记录状态已变化，请重新打开后保存；当前编辑尚未覆盖任何记录。');
    }
    if (current && !await tx.groupPageRevision.findFirst({ where: { offeringId, groupId, revision: current.revision }, select: { revision: true } })) {
      // Existing content has no reconstructable edit history. Capture it now
      // as an unattributed baseline instead of inventing an earlier save.
      await tx.groupPageRevision.create({ data: { offeringId, groupId, revision: current.revision, title: current.title, body: current.body, isBaseline: true } });
    }
    const values = { title: title.trim(), body: body.trim(), status: 'PUBLISHED' as const, visibility: 'OFFERING' as const };
    if (current) {
      const changed = await tx.groupPage.updateMany({ where: { offeringId, groupId, revision: expectedRevision }, data: { ...values, revision: { increment: 1 } } });
      if (changed.count !== 1) throw Object.assign(new Error('Group page revision changed'), { code: 'GROUP_PAGE_RACE' });
    } else {
      await tx.groupPage.create({ data: { offeringId, groupId, ...values, revision: 1 } });
    }
    const page = await tx.groupPage.findFirstOrThrow({ where: { offeringId, groupId }, select: groupPageSelect });
    await tx.groupPageRevision.create({ data: { offeringId, groupId, revision: page.revision, title: page.title, body: page.body, actorUserId: userId } });
    return groupPageContent(page);
  });
}
