import { randomUUID } from 'node:crypto';
import { Prisma, type CourseOffering, type Group, type GroupRecruitmentMode } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { DomainError } from './management';
import { canManageOffering } from './policy';

type Tx = Prisma.TransactionClient;
type FormationOffering = Pick<CourseOffering, 'status' | 'groupFormationWindowId' | 'groupFormationClosesAt' | 'groupFormationCapacity'>;
type FormationConfig = { capacity: number; closesAt: Date };
type Recruitment = Pick<Group, 'recruitmentMode' | 'recruitmentWindowId' | 'recruitmentToken' | 'recruitmentNote'>;

const offeringSelect = { status: true, groupFormationWindowId: true, groupFormationClosesAt: true, groupFormationCapacity: true } as const;
const recruitmentSelect = { recruitmentMode: true, recruitmentWindowId: true, recruitmentToken: true, recruitmentNote: true } as const;
const currentStudents = { leftAt: null, courseMember: { role: 'STUDENT', status: 'ACTIVE' } } satisfies Prisma.GroupMemberWhereInput;
const summarySelect = {
  id: true, name: true, recruitmentNote: true, _count: { select: { members: { where: currentStudents } } },
} satisfies Prisma.GroupSelect;

const uuid = z.uuid('组队请求已失效，请刷新页面后再试。');
const groupId = z.string().min(1).max(150);
const note = z.string().trim().max(300, '招募说明请控制在 300 字以内。');
const configuration = z.object({
  capacity: z.number().int().min(2, '每组人数上限至少为 2 人。').max(100, '每组人数上限最多为 100 人。'),
  closesAt: z.date('请选择有效的组队截止时间。'),
});
const creation = z.object({
  name: z.string().trim().min(1, '请填写小组名称。').max(100, '小组名称请控制在 100 字以内。'),
  note, mode: z.enum(['COURSE', 'INVITE']), windowId: uuid, requestId: uuid,
});
const join = z.object({ groupId: groupId.optional(), inviteToken: uuid.optional(), windowId: uuid, requestId: uuid })
  .refine(value => Boolean(value.groupId) !== Boolean(value.inviteToken), '请选择一个要加入的小组。');
const recruitment = z.object({ mode: z.enum(['COURSE', 'INVITE', 'CLOSED']), note, windowId: uuid });

export function getGroupFormationWindow(offering: FormationOffering, now = new Date()) {
  const { status, groupFormationWindowId: id, groupFormationCapacity: capacity, groupFormationClosesAt: closesAt } = offering;
  if (status === 'ARCHIVED' || !id || capacity === null || !closesAt || closesAt <= now) return null;
  return { id, capacity, closesAt };
}

function requireWindow(offering: FormationOffering | null, expectedWindow: string) {
  const window = offering && getGroupFormationWindow(offering);
  if (!window) throw new DomainError('本轮组队尚未开放或已经结束。');
  if (window.id !== expectedWindow) throw new DomainError('组队安排已更新，请刷新页面后再试。');
  return window;
}

const conflictCodes = new Set(['P2034', 'P2002', '40001', '40P01', '23505']);
function isWriteConflict(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false;
  const value = error as Record<string, unknown>;
  return conflictCodes.has(String(value.code)) || conflictCodes.has(String(value.originalCode))
    || value.kind === 'TransactionWriteConflict'
    || ['cause', 'meta', 'driverAdapterError'].some(key => isWriteConflict(value[key], depth + 1));
}

async function transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isWriteConflict(error)) throw error;
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 10));
    }
  }
  throw new DomainError('组队记录正在更新，请刷新页面后重试。');
}

// Closing or archiving updates the same row, so an in-flight join checks a stable window.
async function lockOffering(tx: Tx, offeringId: string, edit = false) {
  const lock = edit ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR SHARE`;
  const [offering] = await tx.$queryRaw<FormationOffering[]>(Prisma.sql`
    SELECT "status", "groupFormationWindowId", "groupFormationClosesAt", "groupFormationCapacity"
    FROM "CourseOffering" WHERE "id" = ${offeringId} ${lock}
  `);
  return offering ?? null;
}

async function lockGroup(tx: Tx, offeringId: string, groupId: string) {
  const [group] = await tx.$queryRaw<({ id: string } & Recruitment)[]>(Prisma.sql`
    SELECT "id", "recruitmentMode", "recruitmentWindowId", "recruitmentToken", "recruitmentNote"
    FROM "Group" WHERE "offeringId" = ${offeringId} AND "id" = ${groupId} FOR UPDATE
  `);
  return group ?? null;
}

async function courseMember(tx: Tx, userId: string, offeringId: string) {
  return tx.courseMember.findUnique({
    where: { offeringId_userId: { offeringId, userId } }, select: { id: true, role: true, status: true },
  });
}

async function activeStudentId(tx: Tx, userId: string, offeringId: string) {
  const member = await courseMember(tx, userId, offeringId);
  return member?.role === 'STUDENT' && member.status === 'ACTIVE' ? member.id : null;
}

async function requireStudent(tx: Tx, userId: string, offeringId: string) {
  const id = await activeStudentId(tx, userId, offeringId);
  if (!id) throw new DomainError('只有本期在读学生可以参与组队。');
  return id;
}

async function currentGroupId(tx: Tx, offeringId: string, courseMemberId: string) {
  const membership = await tx.groupMember.findFirst({ where: { offeringId, courseMemberId, leftAt: null }, select: { groupId: true } });
  return membership?.groupId ?? null;
}

async function existingReceipt(tx: Tx, offeringId: string, courseMemberId: string, requestId: string) {
  const receipt = await tx.groupMember.findUnique({ where: { id: requestId }, select: {
    offeringId: true, courseMemberId: true, groupId: true, group: { select: { name: true } },
  } });
  if (receipt && (receipt.offeringId !== offeringId || receipt.courseMemberId !== courseMemberId)) {
    throw new DomainError('这个请求标识已被使用，请重新打开组队页面。');
  }
  return receipt;
}

async function ungroupedStudentWindow(tx: Tx, userId: string, offeringId: string) {
  const offering = await tx.courseOffering.findUnique({ where: { id: offeringId }, select: offeringSelect });
  const window = offering && getGroupFormationWindow(offering);
  if (!window) return null;
  const memberId = await activeStudentId(tx, userId, offeringId);
  return memberId && !await currentGroupId(tx, offeringId, memberId) ? window : null;
}

function recruitmentSummary(group: { name: string; recruitmentNote: string; _count: { members: number } }, capacity: number) {
  return { name: group.name, note: group.recruitmentNote, remaining: Math.max(0, capacity - group._count.members) };
}

export async function setGroupFormation(userId: string, offeringId: string, input: FormationConfig | null, expectedOpenWindowId: string | null) {
  const values = input === null ? null : configuration.parse(input);
  return transaction(async tx => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    const member = await courseMember(tx, userId, offeringId);
    if (!user || !canManageOffering(user.isAdmin, member)) throw new DomainError('只有本期教师或管理员可以管理组队。');
    const offering = await lockOffering(tx, offeringId, true);
    if (!offering) throw new DomainError('本期开课不存在。');
    if (offering.status === 'ARCHIVED') throw new DomainError('已归档课程不能开放学生组队。');

    const now = new Date();
    const open = getGroupFormationWindow(offering, now);
    if ((open?.id ?? null) !== expectedOpenWindowId) throw new DomainError('组队安排已有变化，请刷新页面后再试。');
    if (!values) {
      if (open) await tx.courseOffering.update({ where: { id: offeringId }, data: { groupFormationClosesAt: now } });
      return null;
    }
    if (values.closesAt <= now) throw new DomainError('组队截止时间须晚于当前时间。');
    const id = open?.id ?? randomUUID();
    await tx.courseOffering.update({ where: { id: offeringId }, data: {
      groupFormationWindowId: id, groupFormationCapacity: values.capacity, groupFormationClosesAt: values.closesAt,
    } });
    return { id, ...values };
  });
}

export async function listRecruitingGroups(userId: string, offeringId: string) {
  return transaction(async tx => {
    const window = await ungroupedStudentWindow(tx, userId, offeringId);
    if (!window) return [];
    const groups = await tx.group.findMany({
      where: { offeringId, recruitmentMode: 'COURSE', recruitmentWindowId: window.id, members: { some: currentStudents } },
      select: summarySelect, orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return groups.filter(group => group._count.members < window.capacity)
      .map(group => ({ id: group.id, ...recruitmentSummary(group, window.capacity) }));
  });
}

export async function readGroupInvitation(userId: string, offeringId: string, token: string) {
  if (!uuid.safeParse(token).success) return null;
  return transaction(async tx => {
    const window = await ungroupedStudentWindow(tx, userId, offeringId);
    if (!window) return null;
    const group = await tx.group.findFirst({ where: {
      offeringId, recruitmentToken: token, recruitmentMode: 'INVITE', recruitmentWindowId: window.id, members: { some: currentStudents },
    }, select: summarySelect });
    return group ? recruitmentSummary(group, window.capacity) : null;
  });
}

export async function createStudentGroup(userId: string, offeringId: string, input: {
  name: string; note: string; mode: 'COURSE' | 'INVITE'; windowId: string; requestId: string;
}) {
  const values = creation.parse(input);
  return transaction(async tx => {
    const memberId = await requireStudent(tx, userId, offeringId);
    const offering = await lockOffering(tx, offeringId);
    const receipt = await existingReceipt(tx, offeringId, memberId, values.requestId);
    const current = await currentGroupId(tx, offeringId, memberId);
    if (receipt) {
      if (receipt.groupId !== values.requestId || receipt.group.name !== values.name) {
        throw new DomainError('这个请求标识已被使用，请重新打开组队页面。');
      }
      return { groupId: current };
    }
    requireWindow(offering, values.windowId);
    if (current) throw new DomainError('你已加入小组。如需调整，请联系课程教师。');
    if (await tx.group.findUnique({ where: { offeringId_name: { offeringId, name: values.name } }, select: { id: true } })) {
      throw new DomainError('本期已有同名小组，请换一个名称。');
    }
    requireWindow(offering, values.windowId);
    // The group and the creator's consent commit together. A repeat finds the original membership.
    const group = await tx.group.create({ data: {
      id: values.requestId, offeringId, name: values.name, recruitmentMode: values.mode, recruitmentWindowId: values.windowId,
      recruitmentToken: values.mode === 'INVITE' ? randomUUID() : null, recruitmentNote: values.note,
    }, select: { id: true } });
    await tx.groupMember.create({ data: { id: values.requestId, offeringId, groupId: group.id, courseMemberId: memberId } });
    return { groupId: group.id };
  });
}

export async function joinStudentGroup(userId: string, offeringId: string, input: {
  groupId?: string; inviteToken?: string; windowId: string; requestId: string;
}) {
  const values = join.parse(input);
  return transaction(async tx => {
    const memberId = await requireStudent(tx, userId, offeringId);
    const offering = await lockOffering(tx, offeringId);
    const receipt = await existingReceipt(tx, offeringId, memberId, values.requestId);
    const current = await currentGroupId(tx, offeringId, memberId);
    if (receipt) {
      if (receipt.groupId === values.requestId || (values.groupId && receipt.groupId !== values.groupId)) {
        throw new DomainError('这个请求标识已被使用，请重新打开组队页面。');
      }
      return { groupId: current };
    }
    requireWindow(offering, values.windowId);
    if (current) throw new DomainError('你已加入小组。如需调整，请联系课程教师。');

    const targetId = values.groupId ?? (await tx.group.findFirst({
      where: { offeringId, recruitmentToken: values.inviteToken }, select: { id: true },
    }))?.id;
    const group = targetId ? await lockGroup(tx, offeringId, targetId) : null;
    if (!group || group.recruitmentWindowId !== values.windowId
      || (values.groupId ? group.recruitmentMode !== 'COURSE'
        : group.recruitmentMode !== 'INVITE' || group.recruitmentToken !== values.inviteToken)) {
      throw new DomainError('小组或邀请已失效，请重新查看组队安排。');
    }
    if (group.id === values.requestId) throw new DomainError('组队请求已失效，请刷新页面后再试。');
    const count = await tx.groupMember.count({ where: { offeringId, groupId: group.id, ...currentStudents } });
    const window = requireWindow(offering, values.windowId);
    if (count === 0) throw new DomainError('这个小组已停止招募。');
    if (count >= window.capacity) throw new DomainError('这个小组已满，请选择其他小组。');
    await tx.groupMember.create({ data: { id: values.requestId, offeringId, groupId: group.id, courseMemberId: memberId } });
    return { groupId: group.id };
  });
}

export async function updateGroupRecruitment(userId: string, offeringId: string, groupId: string, input: {
  mode: GroupRecruitmentMode; note: string; windowId: string;
}) {
  const values = recruitment.parse(input);
  return transaction(async tx => {
    const memberId = await requireStudent(tx, userId, offeringId);
    const offering = await lockOffering(tx, offeringId);
    requireWindow(offering, values.windowId);
    if (await currentGroupId(tx, offeringId, memberId) !== groupId) throw new DomainError('只有本组当前组员可以管理招募。');
    const group = await lockGroup(tx, offeringId, groupId);
    if (!group?.recruitmentMode) throw new DomainError('这个小组由教学团队分配。需要调整时请联系课程教师。');

    requireWindow(offering, values.windowId);
    const existingToken = group.recruitmentMode === 'INVITE' && group.recruitmentWindowId === values.windowId
      ? group.recruitmentToken : null;
    return tx.group.update({ where: { id_offeringId: { id: groupId, offeringId } }, data: {
      recruitmentMode: values.mode, recruitmentWindowId: values.windowId,
      recruitmentToken: values.mode === 'INVITE' ? existingToken ?? randomUUID() : null, recruitmentNote: values.note,
    }, select: recruitmentSelect });
  });
}
