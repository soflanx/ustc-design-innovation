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
    return tx.courseOffering.update({ where: { id: offeringId }, data: { status } });
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

export async function saveGroupPage(userId: string, offeringId: string, groupId: string, title: string, body: string) {
  return transactional(async tx => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    const offering = await tx.courseOffering.findUnique({ where: { id: offeringId } });
    const group = await tx.group.findFirst({ where: { id: groupId, offeringId } });
    const member = await tx.courseMember.findFirst({ where: { userId, offeringId } });
    const ownGroup = member ? !!await tx.groupMember.findFirst({ where: { groupId, courseMemberId: member.id, leftAt: null } }) : false;
    if (!user || !offering || !group || !canViewGroup(user.isAdmin, member, ownGroup) || (!user.isAdmin && !ownGroup)) throw new DomainError('只有本组成员或管理员可以编辑小组主页。');
    if (offering.status === 'ARCHIVED') throw new DomainError('已归档学期的小组主页保持只读。');
    return tx.groupPage.upsert({
      where: { groupId },
      create: { offeringId, groupId, title, body, status: 'PUBLISHED', visibility: 'OFFERING' },
      update: { title, body, status: 'PUBLISHED', visibility: 'OFFERING' },
    });
  });
}
