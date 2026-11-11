import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { DomainError } from './management';
import { studentSubmissionVersionVisibility } from './teaching';
import { toTeachingDateInput } from './teaching-format';
import { lessonStudentEventKinds, teachingRecordKindLabels, teachingRecordKinds } from './teaching-record-kind';

const id = z.string().min(1).max(200);
const noteFields = z.object({
  targetMemberId: id.nullable(), targetGroupId: id.nullable(), versionId: id.nullable(),
  body: z.string().trim().min(1, '请填写内容。').max(12000),
  context: z.string().trim().max(1000).default(''), requestId: z.uuid(),
});
const note = noteFields.refine(input => Boolean(input.targetMemberId) !== Boolean(input.targetGroupId), '请选择一位学生或一个小组。');
export type TeachingFeedbackInput = z.input<typeof note>;
const observationDate = z.iso.datetime().nullable();
const confirmationSourceRequired = '请填写已确认请假的来源。';
const observation = noteFields.extend({
  targetMemberId: noteFields.shape.targetMemberId.default(null),
  targetGroupId: noteFields.shape.targetGroupId.default(null),
  versionId: noteFields.shape.versionId.default(null),
  observedAt: observationDate.default(null),
  pageId: id.nullable().default(null),
  contextGroupId: id.nullable().default(null),
  kind: z.enum(teachingRecordKinds).nullable().default(null),
})
  .refine(input => Boolean(input.targetMemberId) !== Boolean(input.targetGroupId)
    || (!input.targetMemberId && !input.targetGroupId && !!input.pageId && !input.versionId), '请选择一位学生、一个小组，或记录整堂课。')
  .refine(input => !input.contextGroupId || !!input.targetMemberId, '只有个人记录可以另选当时小组。')
  .refine(input => (input.kind !== 'LEAVE_REPORTED' && input.kind !== 'LEAVE_CONFIRMED') || !!input.targetMemberId, '请为请假记录选择一位学生。')
  .refine(input => input.kind !== 'LEAVE_CONFIRMED' || !!input.context, confirmationSourceRequired)
  .refine(input => input.kind !== 'ABSENT', '请在本课的学生情况中记录未到。');
export type TeachingNoteInput = z.input<typeof observation>;

const lessonStudentEvents = z.strictObject({
  pageId: id,
  memberIds: z.array(id).min(1, '请至少选择一位学生。').max(200, '每次最多记录 200 位学生。'),
  kind: z.enum(lessonStudentEventKinds, { error: '请选择请假、未到或课堂发言。' }),
  body: z.string().trim().max(12000, '记录正文请控制在 12000 字以内。')
    .refine(body => !body.includes('\u0000'), '记录正文含有无效字符。').default(''),
  requestId: z.uuid(),
})
  .refine(input => new Set(input.memberIds).size === input.memberIds.length, '学生名单有重复，请重新选择。')
  .refine(input => input.kind !== 'PARTICIPATION' || !!input.body, '请填写课堂发言内容。');
export type LessonStudentEventsInput = z.input<typeof lessonStudentEvents>;
export type LessonStudentEventRecord = { memberId: string; recordId: string };

const revisionRequest = {
  expectedRevision: z.number().int().min(0).max(2147483646),
  requestId: z.uuid(),
};
const correction = z.strictObject({
  ...revisionRequest, body: note.shape.body,
  context: z.string().trim().max(1000).optional(),
  observedAt: observationDate.optional(),
  reason: z.string().trim().max(1000).default(''),
});
const withdrawal = z.strictObject({
  ...revisionRequest, reason: z.string().trim().min(1, '请填写撤回原因。').max(1000),
});
export type TeachingObservationCorrection = z.input<typeof correction>;
export type TeachingObservationWithdrawal = z.input<typeof withdrawal>;

type Tx = Prisma.TransactionClient;

async function staffAccess(tx: Tx, userId: string, offeringId: string, write = false) {
  const member = await tx.courseMember.findUnique({
    where: { offeringId_userId: { offeringId, userId } },
    select: { role: true, status: true, offering: { select: { status: true } } },
  });
  if (!member || member.status !== 'ACTIVE' || (member.role !== 'TEACHER' && member.role !== 'TA')) {
    throw new DomainError('你没有访问本期教学记录的权限。');
  }
  const archived = member.offering.status === 'ARCHIVED';
  if (write && archived) throw new DomainError('已归档课程保持只读。');
  return { archived, role: member.role };
}

type TeachingRecordAccess = Awaited<ReturnType<typeof staffAccess>>;

const unavailable = () => new DomainError('记录对象或关联情境不可用，请重新打开页面。');
const usedRequest = () => new DomainError('记录标识已被使用，请重新打开表单。');

async function validateTarget(tx: Tx, offeringId: string, target: z.output<typeof note>) {
  const { targetMemberId, targetGroupId, versionId } = target;
  if (targetMemberId) {
    const member = await tx.courseMember.findFirst({ where: { id: targetMemberId, offeringId, role: 'STUDENT' }, select: { id: true, status: true } });
    if (!member) throw unavailable();
  } else if (targetGroupId && !await tx.group.findFirst({ where: { id: targetGroupId, offeringId }, select: { id: true } })) throw unavailable();
  if (!versionId) return;
  if (!targetMemberId && !targetGroupId) throw unavailable();
  const version = await tx.submissionVersion.findFirst({
    where: { id: versionId, offeringId, finalizedAt: { not: null },
      ...(targetMemberId
        ? { OR: [{ submission: { courseMemberId: targetMemberId } }, { participants: { some: { courseMemberId: targetMemberId } } }] }
        : { submission: { groupId: targetGroupId } }),
    },
    select: { id: true },
  });
  if (!version) throw unavailable();
}

function beijingObservationDay(date: Date) {
  const day = toTeachingDateInput(date).slice(0, 10);
  const start = new Date(day + 'T00:00:00+08:00');
  return { start, end: new Date(start.getTime() + 86400000) };
}

function requireOccurredDate(observedAt: Date | null) {
  if (observedAt && observedAt.getTime() >= beijingObservationDay(new Date()).end.getTime()) {
    throw new DomainError('实际发生日期不能晚于北京时间今天。');
  }
}

async function validateGroupContext(tx: Tx, offeringId: string, memberId: string | null, groupId: string | null, observedAt: Date | null) {
  if (!groupId) return;
  if (!memberId) throw unavailable();
  let dayRange: Prisma.GroupMemberWhereInput = {};
  if (observedAt) {
    // The observation form records a Beijing calendar date. A stated group
    // must intersect that date, without inferring an exact occurrence time.
    const { start, end } = beijingObservationDay(observedAt);
    dayRange = { joinedAt: { lt: end }, OR: [{ leftAt: null }, { leftAt: { gt: start } }] };
  }
  const membership = await tx.groupMember.findFirst({
    where: { offeringId, courseMemberId: memberId, groupId, ...dayRange },
    select: { id: true },
  });
  if (!membership) throw new DomainError('无法核对该学生在此情境中的小组归属。请核对发生日期或留空小组。');
}

function isRetryable(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false;
  const value = error as Record<string, unknown>;
  return ['P2002', 'P2034', '40001'].includes(String(value.code)) || value.originalCode === '40001'
    || value.kind === 'TransactionWriteConflict'
    || ['cause', 'meta', 'driverAdapterError'].some(key => isRetryable(value[key], depth + 1));
}

async function transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) { if (attempt === 2 || !isRetryable(error)) throw error; }
  }
  throw new DomainError('记录正在更新，请重试。');
}

function checkRetry(existing: { offeringId: string; authorUserId: string; targetMemberId: string | null; targetGroupId: string | null; versionId: string | null; body: string; context: string }, userId: string, offeringId: string, data: z.output<typeof note>) {
  if (existing.offeringId !== offeringId || existing.authorUserId !== userId
    || existing.targetMemberId !== data.targetMemberId || existing.targetGroupId !== data.targetGroupId
    || existing.versionId !== data.versionId || existing.body !== data.body || existing.context !== data.context) {
    throw usedRequest();
  }
}

export async function recordTeachingObservation(userId: string, offeringId: string, input: TeachingNoteInput) {
  const { observedAt: date, ...data } = observation.parse(input);
  const observedAt = date ? new Date(date) : null;
  return transaction(async tx => {
    await staffAccess(tx, userId, offeringId, true);
    const existing = await tx.teachingObservation.findUnique({ where: { requestId: data.requestId } });
    if (existing) {
      checkRetry(existing, userId, offeringId, data);
      if (existing.observedAt?.getTime() !== observedAt?.getTime()
        || existing.kind !== data.kind || existing.pageId !== data.pageId || existing.contextGroupId !== data.contextGroupId) throw usedRequest();
      return { id: existing.id };
    }
    requireOccurredDate(observedAt);
    await validateTarget(tx, offeringId, data);
    if (data.pageId && !await tx.courseSubpage.findFirst({ where: { offeringId, id: data.pageId }, select: { id: true } })) throw unavailable();
    await validateGroupContext(tx, offeringId, data.targetMemberId, data.contextGroupId, observedAt);
    return tx.teachingObservation.create({ data: { ...data, observedAt, offeringId, authorUserId: userId }, select: { id: true } });
  });
}

export async function recordLessonStudentEvents(userId: string, offeringId: string, input: LessonStudentEventsInput): Promise<{ records: LessonStudentEventRecord[] }> {
  const { pageId, memberIds: selected, kind, body: noteBody, requestId } = lessonStudentEvents.parse(input);
  const memberIds = [...selected].sort();
  const body = noteBody || teachingRecordKindLabels[kind];
  // Ordinal zero reserves the batch UUID regardless of its member list. The
  // complete set of immutable rows lets a retry verify the whole original list.
  const prefix = `lesson-students:${requestId.toLowerCase()}:`;
  const key = (index: number) => prefix + index;
  return transaction(async tx => {
    await staffAccess(tx, userId, offeringId, true);
    const first = await tx.teachingObservation.findUnique({
      where: { requestId: key(0) }, select: { offeringId: true, authorUserId: true },
    });
    if (first) {
      if (first.offeringId !== offeringId || first.authorUserId !== userId) throw usedRequest();
      const existing = await tx.teachingObservation.findMany({ where: { offeringId, authorUserId: userId, requestId: { startsWith: prefix } } });
      if (existing.length !== memberIds.length) throw usedRequest();
      const byKey = new Map(existing.map(row => [row.requestId, row]));
      const records = memberIds.map((memberId, index) => {
        const row = byKey.get(key(index));
        if (!row || row.pageId !== pageId || row.kind !== kind || row.observedAt !== null || row.contextGroupId !== null) throw usedRequest();
        checkRetry(row, userId, offeringId, { targetMemberId: memberId, targetGroupId: null, versionId: null, body, context: '', requestId: row.requestId });
        return { memberId, recordId: row.id };
      });
      return { records };
    }

    if (!await tx.courseSubpage.findFirst({ where: { offeringId, id: pageId }, select: { id: true } })) throw unavailable();
    const active = await tx.courseMember.count({ where: { offeringId, id: { in: memberIds }, role: 'STUDENT', status: 'ACTIVE' } });
    if (active !== memberIds.length) throw new DomainError('选择的学生中有人已不在本期有效名单，请刷新后重新选择。');
    const created = await tx.teachingObservation.createManyAndReturn({
      data: memberIds.map((targetMemberId, index) => ({ offeringId, authorUserId: userId, pageId, targetMemberId, kind, body, requestId: key(index) })),
      select: { id: true, targetMemberId: true },
    });
    const byMember = new Map(created.map(row => [row.targetMemberId, row.id]));
    return { records: memberIds.map(memberId => ({ memberId, recordId: byMember.get(memberId)! })) };
  });
}

type Amendment = (z.output<typeof correction> & { action: 'CORRECTED' })
  | (z.output<typeof withdrawal> & { action: 'WITHDRAWN' });

async function amendTeachingObservation(userId: string, offeringId: string, observationId: string, input: Amendment) {
  return transaction(async tx => {
    const access = await staffAccess(tx, userId, offeringId, true);
    const original = await tx.teachingObservation.findFirst({ where: { id: observationId, offeringId } });
    if (!original) throw unavailable();
    if (original.authorUserId !== userId) {
      if (input.action === 'CORRECTED') throw new DomainError('只有原记录作者可以更正这条记录。');
      if (access.role !== 'TEACHER') throw new DomainError('只有原记录作者或本期教师可以撤回这条记录。');
    }
    const existing = await tx.teachingObservationRevision.findUnique({ where: { requestId: input.requestId } });
    const revision = input.expectedRevision + 1;
    if (existing && (existing.observationId !== observationId || existing.offeringId !== offeringId
      || existing.authorUserId !== userId || existing.revision !== revision
      || existing.action !== input.action || existing.reason !== input.reason)) throw usedRequest();
    const latest = await tx.teachingObservationRevision.findFirst({
      where: { offeringId, observationId }, orderBy: { revision: 'desc' },
    });
    if (!existing && ((latest?.revision ?? 0) !== input.expectedRevision || latest?.action === 'WITHDRAWN')) {
      throw new DomainError('这条记录已有更新或已撤回。请刷新核对后再试。');
    }

    let body: string | null = null, context: string | null = null, observedAt: Date | null = null;
    let changedDate = false;
    if (input.action === 'CORRECTED') {
      // On retry, resolve omitted fields against the same immutable prior
      // version, even if a subsequent edit has already been appended.
      const base = input.expectedRevision === 0 ? original : existing
        ? await tx.teachingObservationRevision.findUniqueOrThrow({ where: { observationId_revision: { observationId, revision: input.expectedRevision } } })
        : latest!;
      body = input.body;
      context = input.context ?? base.context!;
      observedAt = input.observedAt === undefined ? base.observedAt : input.observedAt ? new Date(input.observedAt) : null;
      changedDate = observedAt?.getTime() !== base.observedAt?.getTime();
      if (original.kind === 'LEAVE_CONFIRMED' && !context) throw new DomainError(confirmationSourceRequired);
    }
    if (existing) {
      if (existing.body !== body || existing.context !== context || existing.observedAt?.getTime() !== observedAt?.getTime()) throw usedRequest();
      return { id: observationId, revision };
    }
    if (changedDate) {
      requireOccurredDate(observedAt);
      await validateGroupContext(tx, offeringId, original.targetMemberId, original.contextGroupId, observedAt);
    }
    await tx.teachingObservationRevision.create({ data: {
      offeringId, observationId, authorUserId: userId, revision, action: input.action,
      body, context, observedAt, reason: input.reason, requestId: input.requestId,
    } });
    return { id: observationId, revision };
  });
}

export async function correctTeachingObservation(userId: string, offeringId: string, observationId: string, input: TeachingObservationCorrection) {
  return amendTeachingObservation(userId, offeringId, id.parse(observationId), { ...correction.parse(input), action: 'CORRECTED' });
}

export async function withdrawTeachingObservation(userId: string, offeringId: string, observationId: string, input: TeachingObservationWithdrawal) {
  return amendTeachingObservation(userId, offeringId, id.parse(observationId), { ...withdrawal.parse(input), action: 'WITHDRAWN' });
}

export async function sendTeachingFeedback(userId: string, offeringId: string, input: TeachingFeedbackInput) {
  const data = note.parse(input);
  return transaction(async tx => {
    await staffAccess(tx, userId, offeringId, true);
    const existing = await tx.teachingFeedback.findUnique({ where: { requestId: data.requestId } });
    if (existing) {
      checkRetry(existing, userId, offeringId, data);
      return { id: existing.id };
    }
    await validateTarget(tx, offeringId, data);
    const recipients = data.targetMemberId
      ? await tx.courseMember.findMany({ where: { id: data.targetMemberId, offeringId, status: 'ACTIVE', role: 'STUDENT' }, select: { id: true } })
      : (await tx.groupMember.findMany({
          where: { groupId: data.targetGroupId!, offeringId, leftAt: null, courseMember: { role: 'STUDENT', status: 'ACTIVE' } },
          select: { courseMemberId: true },
        })).map(row => ({ id: row.courseMemberId }));
    if (!recipients.length) throw new DomainError('当前没有可接收这条反馈的学生。');
    const feedback = await tx.teachingFeedback.create({
      data: { ...data, offeringId, authorUserId: userId }, select: { id: true },
    });
    await tx.teachingFeedbackRecipient.createMany({
      data: recipients.map(recipient => ({ offeringId, feedbackId: feedback.id, memberId: recipient.id })),
    });
    return feedback;
  });
}

const noteSelect = {
  id: true, body: true, context: true, createdAt: true, author: { select: { name: true } },
  targetGroup: { select: { id: true, name: true } }, targetMember: { select: { id: true, user: { select: { name: true } } } },
  version: { select: { id: true, assignmentRevision: { select: { title: true } }, submission: { select: { assignment: { select: { id: true, title: true } } } } } },
} satisfies Prisma.TeachingObservationSelect;

const lessonSelect = { id: true, title: true, draftTitle: true, publishedAt: true } satisfies Prisma.CourseSubpageSelect;
const observationSelect = {
  ...noteSelect, authorUserId: true, observedAt: true, kind: true,
  page: { select: lessonSelect }, contextGroup: { select: { id: true, name: true } },
  revisions: {
    orderBy: { revision: 'asc' },
    select: {
      revision: true, action: true, body: true, context: true, observedAt: true,
      reason: true, createdAt: true, author: { select: { name: true } },
    },
  },
} satisfies Prisma.TeachingObservationSelect;

function lessonLabel(page: { id: string; title: string; draftTitle: string | null; publishedAt: Date | null }) {
  return { id: page.id, title: page.publishedAt ? page.title : page.draftTitle ?? page.title, publishedAt: page.publishedAt };
}

function observationView(
  row: Prisma.TeachingObservationGetPayload<{ select: typeof observationSelect }>, userId: string, access: TeachingRecordAccess,
) {
  const { authorUserId, revisions, page, ...original } = row;
  const latest = revisions.at(-1);
  const withdrawn = latest?.action === 'WITHDRAWN';
  const current = withdrawn ? revisions.at(-2) : latest;
  const writable = !access.archived && !withdrawn;
  const own = authorUserId === userId;
  return {
    ...original,
    body: current?.body ?? original.body,
    context: current?.context ?? original.context,
    observedAt: current ? current.observedAt : original.observedAt,
    page: page ? lessonLabel(page) : null,
    revision: latest?.revision ?? 0,
    withdrawn,
    canAmend: writable && own,
    canWithdraw: writable && (own || access.role === 'TEACHER'),
    history: [{
      revision: 0, action: 'RECORDED' as const, body: original.body, context: original.context,
      observedAt: original.observedAt, reason: '', author: original.author, createdAt: original.createdAt,
    }, ...revisions],
  };
}

export type TeachingRecordFilters = { pageId?: string; memberId?: string; groupId?: string; includeWithdrawn?: boolean };

async function readObservations(tx: Tx, userId: string, offeringId: string, access: TeachingRecordAccess, filters: TeachingRecordFilters) {
  const { pageId, memberId, groupId, includeWithdrawn } = filters;
  const rows = await tx.teachingObservation.findMany({
    where: {
      offeringId, pageId, targetMemberId: memberId,
      ...(groupId === undefined ? {} : { OR: [{ targetGroupId: groupId }, { contextGroupId: groupId }] }),
      ...(includeWithdrawn ? {} : { revisions: { none: { action: 'WITHDRAWN' } } }),
    },
    select: observationSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return rows.map(row => observationView(row, userId, access));
}

export async function getTeachingObservations(userId: string, offeringId: string, target: { memberId: string } | { groupId: string } | { pageId: string }, { includeWithdrawn }: { includeWithdrawn?: boolean } = {}) {
  return transaction(async tx => {
    const access = await staffAccess(tx, userId, offeringId);
    const observations = await readObservations(tx, userId, offeringId, access, { ...target, includeWithdrawn });
    const feedback = 'pageId' in target ? [] : await tx.teachingFeedback.findMany({
      where: { offeringId, ...('memberId' in target ? { targetMemberId: target.memberId } : { targetGroupId: target.groupId }) },
      select: noteSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { observations, feedback };
  });
}

export async function getTeachingRecordWorkspace(userId: string, offeringId: string, filters: TeachingRecordFilters = {}) {
  return transaction(async tx => {
    const access = await staffAccess(tx, userId, offeringId);
    const pages = await tx.courseSubpage.findMany({
      where: { offeringId }, select: lessonSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const students = await tx.courseMember.findMany({
      where: { offeringId, role: 'STUDENT' },
      select: {
        id: true, status: true, user: { select: { name: true } },
        groupMemberships: {
          select: { id: true, group: { select: { id: true, name: true } }, joinedAt: true, leftAt: true },
          orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
        },
      },
      orderBy: [{ user: { name: 'asc' } }, { id: 'asc' }],
    });
    const groups = await tx.group.findMany({ where: { offeringId }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    const filterAvailable = (filters.pageId === undefined || pages.some(page => page.id === filters.pageId))
      && (filters.memberId === undefined || students.some(student => student.id === filters.memberId))
      && (filters.groupId === undefined || groups.some(group => group.id === filters.groupId));
    const observations = filterAvailable ? await readObservations(tx, userId, offeringId, access, filters) : [];
    return {
      pages: pages.map(lessonLabel), students: students.map(({ user, ...student }) => ({ ...student, name: user.name })),
      groups, observations, archived: access.archived, filterAvailable,
    };
  });
}

export async function getStudentTeachingFeedback(userId: string, offeringId: string) {
  return transaction(async tx => {
    const member = await tx.courseMember.findUnique({ where: { offeringId_userId: { offeringId, userId } }, select: { id: true, role: true, status: true } });
    if (!member || member.role !== 'STUDENT' || member.status !== 'ACTIVE') throw new DomainError('你没有访问本期学生反馈的权限。');
    // This student-facing query never touches the private observation table.
    const feedback = await tx.teachingFeedback.findMany({
      where: { offeringId, OR: [
        { targetMemberId: member.id },
        { targetMemberId: null, recipients: { some: { memberId: member.id } } },
        { targetMemberId: null, targetGroup: { members: { some: { offeringId, courseMemberId: member.id, leftAt: null } } } },
      ] },
      select: {
        id: true, targetMemberId: true, versionId: true, body: true, context: true, createdAt: true,
        author: { select: { name: true } }, targetGroup: { select: { id: true, name: true } },
        recipients: { where: { memberId: member.id }, select: { memberId: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const versionIds = [...new Set(feedback.flatMap(entry => entry.versionId ? [entry.versionId] : []))];
    const versions = versionIds.length ? await tx.submissionVersion.findMany({
      where: { ...studentSubmissionVersionVisibility(offeringId, member.id), id: { in: versionIds } },
      select: noteSelect.version.select,
    }) : [];
    const readable = new Map(versions.map(version => [version.id, version]));
    return feedback.map(({ versionId, targetMemberId, recipients, ...entry }) => {
      const version = versionId && readable.get(versionId);
      const recipientBasis = targetMemberId ? 'PERSONAL' : recipients.length ? 'RECEIVED_GROUP' : 'CURRENT_GROUP_SHARED';
      return {
        ...entry,
        recipientBasis,
        hasResultContext: !!versionId,
        result: version ? { id: version.id, assignmentId: version.submission.assignment.id,
          title: version.assignmentRevision?.title ?? version.submission.assignment.title } : null,
      };
    });
  });
}

export async function getTeachingSubject(userId: string, offeringId: string, target: { memberId: string } | { groupId: string }) {
  return transaction(async tx => {
    await staffAccess(tx, userId, offeringId);
    const member = 'memberId' in target ? await tx.courseMember.findFirst({
      where: { id: target.memberId, offeringId, role: 'STUDENT' },
      select: { id: true, user: { select: { name: true } }, groupMemberships: {
        select: { id: true, group: { select: { id: true, name: true } }, joinedAt: true, leftAt: true },
        orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
      } },
    }) : null;
    if ('memberId' in target && !member) throw unavailable();
    const versions = await tx.submissionVersion.findMany({
      where: { offeringId, finalizedAt: { not: null }, ...('memberId' in target
        ? { OR: [{ submission: { courseMemberId: target.memberId } }, { participants: { some: { courseMemberId: target.memberId } } }] }
        : { submission: { groupId: target.groupId } }) },
      select: { id: true, version: true, submittedAt: true, assignmentRevision: { select: { title: true } }, submission: {
        select: { id: true, group: { select: { name: true } }, assignment: { select: { id: true, title: true } } },
      } },
      orderBy: [{ submittedAt: 'desc' }, { version: 'desc' }, { id: 'desc' }],
    });
    return { member, results: versions };
  });
}
