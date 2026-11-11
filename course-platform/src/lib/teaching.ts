import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type AssignmentMode, type AssignmentStatus, type SubmissionReviewStatus } from '@prisma/client';
import { db } from './db';
import { DomainError } from './management';
import { canManageOffering, canViewOffering } from './policy';
import { submissionRequirementText } from './submission-requirement-text';
import { MAX_SUBMISSION_FILES, MAX_SUBMISSION_FILE_BYTES, type SubmissionAttachment, type SubmissionContext, type SubmissionConflictReason, type SubmissionInput } from './submission-contract';

type Tx = Prisma.TransactionClient;

export type AssignmentInput = {
  title: string;
  description: string;
  mode: AssignmentMode;
  status: AssignmentStatus;
  dueAt: Date | null;
  cancellationReason?: string | null;
  maxScore?: number;
};

export type AssignmentSummary = {
  submittedCount: number;
  pendingFeedbackCount: number;
  feedbackCount: number;
  completedReviewCount: number;
  unknownReviewCount: number;
  totalExpectedCount: number;
};

export type AssignmentProgress = {
  state: 'UNGROUPED' | 'NOT_SUBMITTED' | 'SUBMITTED' | 'FEEDBACK_AVAILABLE' | 'CANCELLED';
  latestVersionId: string | null;
  feedbackCount: number;
  reviewState: SubmissionReviewStatus | null;
};

export type AssignmentReviewQueueItem = {
  id: string;
  ownerLabel: string;
  groupId: string | null;
  latestVersionId: string | null;
  latestVersionNumber: number | null;
  submittedAt: Date | null;
  feedbackCount: number;
  reviewState: SubmissionReviewStatus | null;
  reviewRevision: number | null;
  assignedToMe: boolean;
  submissionId: string | null;
  correctionUntil: Date | null;
  correctionRevision: number;
};

type AssignmentOverview = {
  summary: AssignmentSummary | null;
  mineSummary: AssignmentSummary | null;
  progress: AssignmentProgress | null;
  reviewQueue: AssignmentReviewQueueItem[];
};

const assignmentSelect = {
  id: true, offeringId: true, title: true, description: true,
  mode: true, status: true, dueAt: true, maxScore: true, revision: true, cancellationReason: true,
} satisfies Prisma.AssignmentSelect;

const revisionSelect = {
  id: true, assignmentId: true, offeringId: true, revision: true,
  title: true, description: true, mode: true, dueAt: true, maxScore: true,
  status: true, cancellationReason: true, actorUserId: true, createdAt: true, isBaseline: true,
} satisfies Prisma.AssignmentRevisionSelect;

const versionSelect = {
  id: true, offeringId: true, submissionId: true, version: true,
  body: true, submittedAt: true, finalizedAt: true,
  assignmentRevisionId: true, assignmentRevision: { select: revisionSelect },
} satisfies Prisma.SubmissionVersionSelect;

const versionSourceSelect = { ...versionSelect, submittedById: true } satisfies Prisma.SubmissionVersionSelect;
type VersionSource = Prisma.SubmissionVersionGetPayload<{ select: typeof versionSourceSelect }>;
type AssignmentRow = Prisma.AssignmentGetPayload<{ select: typeof assignmentSelect }>;
type AssignmentView = Omit<AssignmentRow, 'maxScore'> & { maxScore: number };
type RevisionRow = Prisma.AssignmentRevisionGetPayload<{ select: typeof revisionSelect }>;

function assignmentView(row: AssignmentRow): AssignmentView {
  return { id: row.id, offeringId: row.offeringId, title: row.title, description: row.description, mode: row.mode,
    status: row.status, dueAt: row.dueAt, maxScore: Number(row.maxScore), revision: row.revision, cancellationReason: row.cancellationReason };
}
function revisionView(row: RevisionRow) { return { ...row, maxScore: Number(row.maxScore) }; }
function versionView<T extends { assignmentRevision: RevisionRow | null }>(row: T): Omit<T, 'assignmentRevision'> & { assignmentRevision: ReturnType<typeof revisionView> | null } {
  const { assignmentRevision, ...version } = row;
  return { ...version, assignmentRevision: assignmentRevision ? revisionView(assignmentRevision) : null };
}

function text(value: unknown, label: string, max: number, required = true) {
  if (typeof value !== 'string') throw new DomainError(`请填写有效的${label}。`);
  const result = value.trim();
  if ((required && !result) || result.length > max) {
    throw new DomainError(`${label}${required ? `须为 1–${max}` : `不能超过 ${max}`} 字。`);
  }
  return result;
}

function assignmentInput(input: AssignmentInput): AssignmentInput {
  if (!input || !['INDIVIDUAL', 'GROUP'].includes(input.mode)) throw new DomainError('请选择个人或小组作业。');
  if (!['DRAFT', 'PUBLISHED', 'ARCHIVED', 'CANCELLED'].includes(input.status)) throw new DomainError('请选择有效的作业状态。');
  if (input.dueAt !== null && (!(input.dueAt instanceof Date) || !Number.isFinite(input.dueAt.getTime()))) {
    throw new DomainError('请填写有效的截止时间，或留空。');
  }
  if (input.maxScore !== undefined && (!Number.isFinite(input.maxScore) || input.maxScore < 0 || input.maxScore > 999999.99 || Math.abs(Math.round(input.maxScore * 100) - input.maxScore * 100) > 1e-7)) {
    throw new DomainError('作业满分须为有效的非负数字，最多两位小数。');
  }
  return {
    title: text(input.title, '作业标题', 100),
    description: text(input.description, '作业说明', 12000, false),
    mode: input.mode,
    status: input.status,
    dueAt: input.dueAt,
    maxScore: input.maxScore,
    cancellationReason: input.status === 'CANCELLED' ? text(input.cancellationReason, '取消原因', 2000) : null,
  };
}

async function transactional<T>(work: (tx: Tx) => Promise<T>, retryUnique = false): Promise<T> {
  // Concurrent first submissions can race on the owner key; later versions can
  // race on their version number. Always retry the entire authorization/snapshot.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const retry = isSerializationConflict(error)
        || (retryUnique && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002');
      if (!retry) throw error;
      if (attempt === 4) throw new DomainError('提交正在更新，请稍后重试；请保留当前表单。');
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 10));
    }
  }
  throw new DomainError('数据正在更新，请重试。');
}

function isSerializationConflict(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false;
  const value = error as Record<string, unknown>;
  return value.code === 'P2034' || value.code === '40001' || value.originalCode === '40001' || value.kind === 'TransactionWriteConflict'
    || ['cause', 'meta', 'driverAdapterError'].some(key => isSerializationConflict(value[key], depth + 1));
}

async function context(tx: Tx, userId: string, offeringId: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
  const offering = await tx.courseOffering.findUnique({ where: { id: offeringId }, select: { id: true, title: true, status: true } });
  const member = await tx.courseMember.findUnique({ where: { offeringId_userId: { offeringId, userId } } });
  if (!user || !offering || !canViewOffering(user.isAdmin, member)) throw new DomainError('课程不存在或你没有访问权限。');
  const isStaff = member?.status === 'ACTIVE' && (member.role === 'TEACHER' || member.role === 'TA');
  const isManager = canManageOffering(user.isAdmin, member);
  return {
    offering, member,
    canManage: isManager && offering.status !== 'ARCHIVED',
    canReview: isStaff && offering.status !== 'ARCHIVED',
    readAll: user.isAdmin || isStaff,
    isTa: !user.isAdmin && member?.status === 'ACTIVE' && member.role === 'TA',
    isManager,
  };
}

type Context = Awaited<ReturnType<typeof context>>;

function publicContext(access: Context) {
  return { offering: access.offering, member: access.member, canManage: access.canManage, canReview: access.canReview };
}

function requireWritable(access: Context) {
  if (access.offering.status === 'ARCHIVED') throw new DomainError('已归档课程保持只读。');
}

function requireManager(access: Context) {
  if (!access.isManager) throw new DomainError('只有本期教师或管理员可以管理作业。');
  requireWritable(access);
}

function assignmentVisibility(access: Context): Prisma.AssignmentWhereInput {
  return access.readAll ? {} : { status: { in: ['PUBLISHED', 'ARCHIVED', 'CANCELLED'] } };
}

export function studentSubmissionVersionVisibility(offeringId: string, courseMemberId: string): Prisma.SubmissionVersionWhereInput {
  return {
    offeringId, finalizedAt: { not: null },
    AND: { submission: { assignment: { status: { in: ['PUBLISHED', 'ARCHIVED', 'CANCELLED'] } } } },
    OR: [
      { participants: { some: { courseMemberId } } },
      { submission: { courseMemberId } },
      { submission: { group: { members: { some: { offeringId, courseMemberId, leftAt: null } } } } },
    ],
  };
}

function versionVisibility(access: Context): Prisma.SubmissionVersionWhereInput {
  return access.readAll
    ? { offeringId: access.offering.id, finalizedAt: { not: null } }
    : studentSubmissionVersionVisibility(access.offering.id, access.member!.id);
}

async function visibleAssignment(tx: Tx, access: Context, assignmentId: string) {
  const assignment = await tx.assignment.findFirst({
    where: { id: assignmentId, offeringId: access.offering.id, ...assignmentVisibility(access) },
    select: assignmentSelect,
  });
  if (!assignment) throw new DomainError('作业不存在或你没有访问权限。');
  return assignmentView(assignment);
}

async function versionAttachments(tx: Tx, offeringId: string, versionIds: string[]) {
  const files = await tx.submissionFile.findMany({
    where: { offeringId, versionId: { in: versionIds } },
    orderBy: [{ file: { createdAt: 'asc' } }, { fileId: 'asc' }],
    select: { versionId: true, file: { select: { id: true, originalName: true, sizeBytes: true } } },
  });
  const byVersion = new Map<string, SubmissionAttachment[]>();
  for (const { versionId, file } of files) {
    const attachments = byVersion.get(versionId) ?? [];
    attachments.push({ id: file.id, name: file.originalName, size: Number(file.sizeBytes) });
    byVersion.set(versionId, attachments);
  }
  return byVersion;
}

async function detailVersions(tx: Tx, offeringId: string, rows: VersionSource[]) {
  const versionIds = rows.map(row => row.id);
  const attachments = await versionAttachments(tx, offeringId, versionIds);
  // Prisma can execute sibling relation selects concurrently on a transaction's
  // single pg connection. Read flat batches sequentially instead, then assemble
  // only the versions already authorized by versionVisibility.
  const participants = await tx.submissionParticipant.findMany({
    where: { offeringId, versionId: { in: versionIds } },
    orderBy: { courseMemberId: 'asc' },
    select: { versionId: true, courseMemberId: true },
  });
  const submissions = await tx.submission.findMany({
    where: { offeringId, id: { in: rows.map(row => row.submissionId) } },
    select: { id: true, groupId: true, courseMemberId: true },
  });
  const reviews = await tx.review.findMany({
    where: { offeringId, versionId: { in: versionIds } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, versionId: true, reviewerId: true, body: true, createdAt: true },
  });
  const reviewStates = await tx.submissionVersionReview.findMany({
    where: { offeringId, versionId: { in: versionIds } },
    select: { versionId: true, state: true, revision: true, updatedById: true, updatedAt: true },
  });
  const reviewEvents = await tx.submissionReviewEvent.findMany({
    where: { offeringId, versionId: { in: versionIds } }, orderBy: { revision: 'desc' },
    select: { versionId: true, revision: true, state: true, actorId: true, createdAt: true, isBaseline: true },
  });
  const memberIds = new Set([
    ...rows.map(row => row.submittedById),
    ...participants.map(row => row.courseMemberId),
    ...reviews.map(row => row.reviewerId),
    ...reviewStates.flatMap(row => row.updatedById ? [row.updatedById] : []),
    ...reviewEvents.flatMap(row => row.actorId ? [row.actorId] : []),
    ...submissions.flatMap(row => row.courseMemberId ? [row.courseMemberId] : []),
  ]);
  const members = await tx.courseMember.findMany({
    where: { offeringId, id: { in: [...memberIds] } },
    select: { id: true, userId: true, role: true },
  });
  const users = await tx.user.findMany({
    where: { id: { in: members.map(row => row.userId) } }, select: { id: true, name: true },
  });
  const groups = await tx.group.findMany({
    where: { offeringId, id: { in: submissions.flatMap(row => row.groupId ? [row.groupId] : []) } },
    select: { id: true, name: true },
  });
  const userMap = new Map(users.map(row => [row.id, row]));
  const memberMap = new Map(members.map(row => [row.id, { id: row.id, role: row.role, name: userMap.get(row.userId)!.name }]));
  const groupMap = new Map(groups.map(row => [row.id, row]));
  const submissionMap = new Map(submissions.map(row => [row.id, row]));
  const reviewStateMap = new Map(reviewStates.map(row => [row.versionId, row]));
  return rows.map(({ submittedById, ...version }) => {
    const submitter = memberMap.get(submittedById)!;
    const submission = submissionMap.get(version.submissionId)!;
    const storedState = reviewStateMap.get(version.id);
    const feedback = reviews.filter(row => row.versionId === version.id);
    return {
      ...versionView(version),
      attachments: attachments.get(version.id) ?? [],
      submittedBy: { id: submitter.id, name: submitter.name },
      participants: participants.filter(row => row.versionId === version.id).map(row => {
        const member = memberMap.get(row.courseMemberId)!;
        return { id: member.id, name: member.name };
      }),
      ownerLabel: submission.groupId ? groupMap.get(submission.groupId)!.name : memberMap.get(submission.courseMemberId!)!.name,
      feedback: feedback.map(({ reviewerId, versionId: _versionId, ...review }) => ({
        ...review, reviewer: memberMap.get(reviewerId)!,
      })),
      reviewState: {
        ...effectiveReviewState(storedState, feedback.length),
        updatedAt: storedState?.updatedAt ?? null,
        updatedBy: storedState?.updatedById ? memberMap.get(storedState.updatedById) ?? null : null,
      },
      reviewHistory: reviewEvents.filter(row => row.versionId === version.id).map(({ versionId: _versionId, actorId, ...event }) => ({
        ...event, actor: actorId ? memberMap.get(actorId) ?? null : null,
      })),
    };
  });
}

async function currentGroup(tx: Tx, access: Context) {
  if (access.member?.role !== 'STUDENT' || access.member.status !== 'ACTIVE') return null;
  const membership = await tx.groupMember.findFirst({
    where: { offeringId: access.offering.id, courseMemberId: access.member.id, leftAt: null },
    select: { group: { select: { id: true, name: true } } },
  });
  return membership?.group ?? null;
}

function summarizeQueue(queue: AssignmentReviewQueueItem[]): AssignmentSummary {
  return {
    totalExpectedCount: queue.length,
    submittedCount: queue.filter(row => row.latestVersionId !== null).length,
    pendingFeedbackCount: queue.filter(row => row.latestVersionId !== null && row.reviewState === 'PENDING').length,
    // Count owners with feedback, rather than individual feedback comments.
    feedbackCount: queue.filter(row => row.latestVersionId !== null && row.feedbackCount > 0).length,
    completedReviewCount: queue.filter(row => row.latestVersionId !== null && row.reviewState === 'COMPLETED').length,
    unknownReviewCount: queue.filter(row => row.latestVersionId !== null && row.reviewState === 'LEGACY_UNKNOWN').length,
  };
}

function effectiveReviewState(stored: { state: SubmissionReviewStatus; revision: number } | null | undefined, feedbackCount: number): { state: SubmissionReviewStatus; revision: number } {
  // Raw fixtures and imported legacy versions may not have a state row yet.
  // Comments are evidence of discussion, never evidence of completed review.
  return stored ? { state: stored.state, revision: stored.revision }
    : { state: feedbackCount > 0 ? 'LEGACY_UNKNOWN' : 'PENDING', revision: 0 };
}

async function assignmentOverview(
  tx: Tx,
  access: Context,
  assignments: AssignmentView[],
  knownGroup?: { id: string; name: string } | null,
) {
  const overview = new Map<string, AssignmentOverview>();
  if (!assignments.length) return overview;
  const offeringId = access.offering.id;
  const group = !access.readAll && assignments.some(row => row.mode === 'GROUP')
    ? knownGroup === undefined ? await currentGroup(tx, access) : knownGroup
    : null;
  const submissions = await tx.submission.findMany({
    where: {
      offeringId, assignmentId: { in: assignments.map(row => row.id) },
      ...(!access.readAll ? {
        OR: [
          { courseMemberId: access.member!.id },
          ...(group ? [{ groupId: group.id }] : []),
        ],
      } : {}),
    },
    select: { id: true, assignmentId: true, courseMemberId: true, groupId: true, correctionUntil: true, correctionRevision: true },
  });
  const latestVersions = await tx.submissionVersion.findMany({
    where: {
      offeringId, submissionId: { in: submissions.map(row => row.id) }, finalizedAt: { not: null },
      // The owner was scoped above to the individual or current group.
    },
    orderBy: [{ submissionId: 'asc' }, { version: 'desc' }],
    distinct: ['submissionId'],
    select: { id: true, submissionId: true, version: true, submittedAt: true },
  });
  const reviewCounts = await tx.review.groupBy({
    by: ['versionId'],
    where: { offeringId, versionId: { in: latestVersions.map(row => row.id) } },
    _count: { _all: true },
  });
  const reviewStates = await tx.submissionVersionReview.findMany({
    where: { offeringId, versionId: { in: latestVersions.map(row => row.id) } },
    select: { versionId: true, state: true, revision: true },
  });
  const latestBySubmission = new Map(latestVersions.map(row => [row.submissionId, row]));
  const feedbackByVersion = new Map(reviewCounts.map(row => [row.versionId, row._count._all]));
  const stateByVersion = new Map(reviewStates.map(row => [row.versionId, row]));

  if (!access.readAll) {
    for (const assignment of assignments) {
      const owner = submissions.find(row => row.assignmentId === assignment.id
        && (assignment.mode === 'INDIVIDUAL' ? row.courseMemberId === access.member!.id : row.groupId === group?.id));
      const latest = owner ? latestBySubmission.get(owner.id) : undefined;
      const feedbackCount = latest ? feedbackByVersion.get(latest.id) ?? 0 : 0;
      const review = latest ? effectiveReviewState(stateByVersion.get(latest.id), feedbackCount) : null;
      overview.set(assignment.id, {
        summary: null,
        mineSummary: null,
        reviewQueue: [],
        progress: {
          state: assignment.status === 'CANCELLED' ? 'CANCELLED' : assignment.mode === 'GROUP' && !group ? 'UNGROUPED'
            : !latest ? 'NOT_SUBMITTED' : feedbackCount ? 'FEEDBACK_AVAILABLE' : 'SUBMITTED',
          latestVersionId: latest?.id ?? null,
          feedbackCount,
          reviewState: review?.state ?? null,
        },
      });
    }
    return overview;
  }

  // Expected owners reflect current enrollment; historical submissions remain
  // available through versions but cannot inflate current completion counts.
  const students = await tx.courseMember.findMany({
    where: { offeringId, role: 'STUDENT', status: 'ACTIVE' },
    select: { id: true, userId: true },
  });
  const memberships = await tx.groupMember.findMany({
    where: { offeringId, leftAt: null, courseMemberId: { in: students.map(row => row.id) } },
    select: { groupId: true, courseMemberId: true },
  });
  const groups = await tx.group.findMany({
    where: { offeringId, id: { in: memberships.map(row => row.groupId) } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true },
  });
  const users = await tx.user.findMany({
    where: { id: { in: students.map(row => row.userId) } },
    select: { id: true, name: true },
  });
  const taAssignments = access.isTa
    ? await tx.taGroupAssignment.findMany({
      where: { offeringId, courseMemberId: access.member!.id, endedAt: null },
      select: { groupId: true },
    })
    : [];
  const assignedGroups = new Set(taAssignments.map(row => row.groupId));
  const groupByStudent = new Map(memberships.map(row => [row.courseMemberId, row.groupId]));
  const userById = new Map(users.map(row => [row.id, row]));
  const individualOwners = students.map(row => ({
    id: row.id, ownerLabel: userById.get(row.userId)!.name, groupId: groupByStudent.get(row.id) ?? null,
  })).sort((a, b) => a.ownerLabel.localeCompare(b.ownerLabel, 'zh-CN') || a.id.localeCompare(b.id));
  const groupOwners = groups.map(row => ({ id: row.id, ownerLabel: row.name, groupId: row.id }));

  for (const assignment of assignments) {
    const owners = assignment.mode === 'INDIVIDUAL' ? individualOwners : groupOwners;
    const ownerSubmissions = new Map(submissions.filter(row => row.assignmentId === assignment.id)
      .map(row => [assignment.mode === 'INDIVIDUAL' ? row.courseMemberId : row.groupId, row]));
    const reviewQueue: AssignmentReviewQueueItem[] = owners.map(owner => {
      const submission = ownerSubmissions.get(owner.id);
      const latest = submission ? latestBySubmission.get(submission.id) : undefined;
      const feedbackCount = latest ? feedbackByVersion.get(latest.id) ?? 0 : 0;
      const review = latest ? effectiveReviewState(stateByVersion.get(latest.id), feedbackCount) : null;
      return {
        ...owner,
        submissionId: submission?.id ?? null,
        correctionUntil: submission?.correctionUntil ?? null,
        correctionRevision: submission?.correctionRevision ?? 0,
        latestVersionId: latest?.id ?? null,
        latestVersionNumber: latest?.version ?? null,
        submittedAt: latest?.submittedAt ?? null,
        feedbackCount,
        reviewState: review?.state ?? null,
        reviewRevision: review?.revision ?? null,
        assignedToMe: owner.groupId !== null && assignedGroups.has(owner.groupId),
      };
    }).filter(row => assignment.status !== 'CANCELLED' || row.latestVersionId !== null);
    const summary = summarizeQueue(reviewQueue);
    const mineSummary = access.isTa ? summarizeQueue(reviewQueue.filter(row => row.assignedToMe)) : null;
    if (assignment.status === 'CANCELLED') {
      summary.totalExpectedCount = 0;
      if (mineSummary) mineSummary.totalExpectedCount = 0;
    }
    overview.set(assignment.id, {
      summary,
      mineSummary,
      progress: null,
      reviewQueue,
    });
  }
  return overview;
}

function submissionBlockedReason(access: Context, assignment: AssignmentView, group: { id: string } | null, now: Date, correctionUntil: Date | null) {
  if (access.offering.status === 'ARCHIVED') return '本期课程已归档，仅可阅读已有记录。';
  if (access.offering.status !== 'ACTIVE') return '课程尚未开放提交。';
  if (access.member?.role !== 'STUDENT' || access.member.status !== 'ACTIVE') return '仅本期在读学生可以提交作业。';
  if (assignment.status === 'CANCELLED') return '本作业已取消，不再要求提交；已有提交和反馈保留。';
  if (assignment.status !== 'PUBLISHED') return assignment.status === 'ARCHIVED' ? '本作业已结束，仅可阅读已有记录。' : '本作业尚未发布。';
  if (assignment.dueAt && now >= assignment.dueAt && (!correctionUntil || now >= correctionUntil)) return '已超过作业截止时间，不能继续提交。';
  if (assignment.mode === 'GROUP' && !group) return '加入本期小组后可代表本组提交。';
  return null;
}

export class SubmissionConflictError extends DomainError {
  constructor(public readonly reasons: SubmissionConflictReason[], public readonly submissionContext: SubmissionContext) {
    super(reasons.includes('group')
      ? '小组已变化，请核对当前归属后再提交；正文仍在草稿中。'
      : reasons.includes('requirements')
        ? '作业要求已更新，请核对当前要求后再提交；正文仍在草稿中。'
        : '当前归属已有新提交，请核对后再提交；正文仍在草稿中。');
  }
}

async function submissionContext(tx: Tx, access: Context, assignment: AssignmentView, group: { id: string; name: string } | null): Promise<SubmissionContext | null> {
  if (access.member?.role !== 'STUDENT' || access.member.status !== 'ACTIVE') return null;
  const owner = assignment.mode === 'INDIVIDUAL'
    ? { courseMemberId: access.member.id }
    : group ? { groupId: group.id } : null;
  const submission = owner ? await tx.submission.findFirst({
    where: { offeringId: access.offering.id, assignmentId: assignment.id, ...owner }, select: { id: true, correctionUntil: true, correctionRevision: true },
  }) : null;
  const latest = submission ? await tx.submissionVersion.findFirst({
    where: { offeringId: access.offering.id, submissionId: submission.id, finalizedAt: { not: null } },
    orderBy: { version: 'desc' }, select: { id: true },
  }) : null;
  // Confirm against the current owner's latest version and correction window.
  const latestSubmissionToken = createHash('sha256').update(JSON.stringify({
    assignmentId: assignment.id, mode: assignment.mode,
    ownerId: assignment.mode === 'INDIVIDUAL' ? access.member.id : group?.id ?? null,
    latestId: latest?.id ?? null, correctionRevision: submission?.correctionRevision ?? 0,
  })).digest('hex');
  const readable = latest ? await tx.submissionVersion.findFirst({
    where: { id: latest.id, ...versionVisibility(access) },
    select: { id: true, version: true, body: true, submittedAt: true, submittedBy: { select: { user: { select: { name: true } } } } },
  }) : null;
  const now = new Date();
  const correctionUntil = latest ? submission?.correctionUntil ?? null : null;
  const blockedReason = submissionBlockedReason(access, assignment, group, now, correctionUntil);
  const activeCorrection = assignment.dueAt && now >= assignment.dueAt && correctionUntil && now < correctionUntil
    ? correctionUntil.toISOString() : null;
  const attachments = readable ? (await versionAttachments(tx, access.offering.id, [readable.id])).get(readable.id) : undefined;
  return {
    confirmation: { assignmentRevision: assignment.revision, latestSubmissionToken, groupId: assignment.mode === 'GROUP' ? group?.id ?? null : null },
    requirements: { revision: assignment.revision, title: assignment.title, ...submissionRequirementText(assignment.description, access.offering.id),
      mode: assignment.mode, status: assignment.status, dueAt: assignment.dueAt?.toISOString() ?? null,
      maxScore: assignment.maxScore, cancellationReason: assignment.cancellationReason },
    latestSubmission: readable ? { id: readable.id, version: readable.version, body: readable.body,
      submittedAt: readable.submittedAt.toISOString(), submittedByName: readable.submittedBy.user.name, attachments: attachments ?? [] } : null,
    groupName: assignment.mode === 'GROUP' ? group?.name ?? null : null,
    canSubmit: blockedReason === null, blockedReason, correctionUntil: activeCorrection,
  };
}

function confirmedSubmission(input: SubmissionInput) {
  if (!Number.isInteger(input.expectedAssignmentRevision) || input.expectedAssignmentRevision < 1
    || typeof input.expectedLatestSubmissionToken !== 'string' || !/^[a-f\d]{64}$/.test(input.expectedLatestSubmissionToken)
    || !Object.hasOwn(input, 'expectedGroupId') || !(input.expectedGroupId === null || typeof input.expectedGroupId === 'string')) {
    throw new DomainError('缺少提交确认信息，请重新核对作业要求与当前提交后再发送；正文仍在草稿中。');
  }
}

function requireRevision(expectedRevision: number | undefined) {
  if (!Number.isInteger(expectedRevision) || expectedRevision! < 1) throw new DomainError('请重新打开作业后保存，缺少有效的作业版本。');
}

export class AssignmentRevisionConflictError extends DomainError {
  constructor() { super('作业已被更新，请重新载入最新内容后保存；当前修改未覆盖。'); }
}

function creationKey(requestId?: string) {
  if (requestId === undefined) return null;
  if (!/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(requestId)) throw new DomainError('创建标识无效，请重新打开新建窗口。');
  return requestId.toLowerCase();
}

async function recordRevision(tx: Tx, assignment: AssignmentView, actorUserId: string | null, isBaseline = false) {
  const { id, ...snapshot } = assignment;
  return tx.assignmentRevision.create({ data: { ...snapshot, assignmentId: id, actorUserId, isBaseline }, select: revisionSelect });
}

async function ensureCurrentRevision(tx: Tx, assignment: AssignmentView) {
  return await tx.assignmentRevision.findUnique({ where: { assignmentId_revision: { assignmentId: assignment.id, revision: assignment.revision } }, select: revisionSelect })
    ?? await recordRevision(tx, assignment, null, true);
}

/** Record versions are independent of the page revision; callers may compose creation with page placement. */
export async function writeAssignmentInTransaction(tx: Tx, userId: string, offeringId: string, input: AssignmentInput, assignmentId?: string, expectedRevision?: number, requestId?: string) {
  const data = assignmentInput(input);
  const access = await context(tx, userId, offeringId);
  requireManager(access);
  if (!assignmentId) {
    if (data.status === 'ARCHIVED' || data.status === 'CANCELLED') throw new DomainError('新作业须先保存为草稿或发布。');
    const key = creationKey(requestId);
    const fingerprint = createHash('sha256').update(JSON.stringify({ ...data, maxScore: data.maxScore ?? 100 })).digest('hex');
    if (key) {
      const existing = await tx.assignment.findUnique({ where: { creationRequestId: key } });
      if (existing) {
        if (existing.creatorId !== userId || existing.offeringId !== offeringId || existing.creationFingerprint !== fingerprint) throw new DomainError('创建标识已被其他内容使用，请重新打开新建窗口。');
        return assignmentView(existing);
      }
    }
    const assignment = assignmentView(await tx.assignment.create({ data: { ...data, offeringId, creatorId: userId, creationRequestId: key, creationFingerprint: key ? fingerprint : null }, select: assignmentSelect }));
    await recordRevision(tx, assignment, userId);
    return assignment;
  }
  const assignment = await visibleAssignment(tx, access, assignmentId);
  requireRevision(expectedRevision);
  if (assignment.revision !== expectedRevision) throw new AssignmentRevisionConflictError();
  if (assignment.status === 'DRAFT' && (data.status === 'ARCHIVED' || data.status === 'CANCELLED')) throw new DomainError('未发布的草稿不能结束或取消，请先发布。');
  if (assignment.status !== 'DRAFT' && data.status === 'DRAFT') throw new DomainError('已发布作业不能退回草稿；可结束作业并保留学生记录。');
  if (assignment.status === 'CANCELLED' && data.status === 'ARCHIVED') throw new DomainError('已取消作业如需重新布置，请恢复发布。');
  if (assignment.mode !== data.mode && await tx.submission.count({ where: { assignmentId, offeringId } })) {
    throw new DomainError('已有提交的作业不能更改个人或小组模式。');
  }
  await ensureCurrentRevision(tx, assignment);
  const changed = await tx.assignment.updateMany({ where: { id: assignment.id, offeringId, revision: expectedRevision }, data: { ...data, revision: { increment: 1 } } });
  if (changed.count !== 1) throw new AssignmentRevisionConflictError();
  const updated = assignmentView(await tx.assignment.findUniqueOrThrow({ where: { id: assignment.id }, select: assignmentSelect }));
  await recordRevision(tx, updated, userId);
  return updated;
}

export async function createAssignment(userId: string, offeringId: string, input: AssignmentInput, requestId?: string) {
  return transactional(tx => writeAssignmentInTransaction(tx, userId, offeringId, input, undefined, undefined, requestId), true);
}

export async function updateAssignment(userId: string, offeringId: string, assignmentId: string, input: AssignmentInput, expectedRevision: number) {
  return transactional(tx => writeAssignmentInTransaction(tx, userId, offeringId, input, assignmentId, expectedRevision));
}

/** Release a reviewed draft without reprocessing the saved requirements. */
export async function publishAssignmentDraftInTransaction(tx: Tx, userId: string, offeringId: string, assignmentId: string, revision: number) {
  const access = await context(tx, userId, offeringId);
  requireManager(access);
  const assignment = await visibleAssignment(tx, access, assignmentId);
  if (assignment.status !== 'DRAFT' || assignment.revision !== revision) throw new AssignmentRevisionConflictError();
  await ensureCurrentRevision(tx, assignment);
  const changed = await tx.assignment.updateMany({
    where: { id: assignmentId, offeringId, status: 'DRAFT', revision },
    data: { status: 'PUBLISHED', revision: { increment: 1 } },
  });
  if (changed.count !== 1) throw new AssignmentRevisionConflictError();
  const published = assignmentView(await tx.assignment.findUniqueOrThrow({ where: { id: assignmentId }, select: assignmentSelect }));
  await recordRevision(tx, published, userId);
}

export async function changeAssignmentStatus(userId: string, offeringId: string, assignmentId: string, input: { status: AssignmentStatus; cancellationReason?: string | null; expectedRevision: number }) {
  return transactional(async tx => {
    const access = await context(tx, userId, offeringId);
    requireManager(access);
    const current = await visibleAssignment(tx, access, assignmentId);
    return writeAssignmentInTransaction(tx, userId, offeringId, { ...current, status: input.status, cancellationReason: input.cancellationReason }, assignmentId, input.expectedRevision);
  });
}

export async function submitAssignment(userId: string, offeringId: string, assignmentId: string, input: SubmissionInput) {
  const body = text(input?.body, '提交说明', 12000, false);
  const retainedFileIds = input.retainedFileIds ?? [];
  const uploads = input.uploads ?? [];
  if (!Array.isArray(retainedFileIds) || !Array.isArray(uploads)
    || retainedFileIds.length + uploads.length > MAX_SUBMISSION_FILES
    || retainedFileIds.some(id => typeof id !== 'string' || !id || id.length > 200)
    || new Set(retainedFileIds).size !== retainedFileIds.length
    || uploads.some(file => !file || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255
      || !(file.bytes instanceof Uint8Array) || !file.bytes.length)) {
    throw new DomainError('提交附件无效或超过数量上限。');
  }
  if (!body && !retainedFileIds.length && !uploads.length) throw new DomainError('请填写说明或添加至少一个附件。');
  const uploadBytes = uploads.reduce((total, file) => total + file.bytes.length, 0);
  if (uploadBytes > MAX_SUBMISSION_FILE_BYTES) throw new DomainError('附件合计不能超过 10 MiB。');
  const fingerprint = createHash('sha256').update(JSON.stringify({
    body, retainedFileIds: [...retainedFileIds].sort(),
    uploads: uploads.map(file => [file.name, createHash('sha256').update(file.bytes).digest('hex')]),
  })).digest('hex');
  if (typeof input?.requestId !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(input.requestId)) {
    throw new DomainError('提交标识无效，请重新打开作业页面。');
  }
  const requestId = input.requestId.toLowerCase();
  return transactional(async tx => {
    const access = await context(tx, userId, offeringId);
    if (access.member?.role !== 'STUDENT' || access.member.status !== 'ACTIVE') throw new DomainError('仅本期在读学生可以提交作业。');
    // A successful request may be retried after the deadline or a group move.
    // Only its original author, assignment, and identical normalized text match.
    const existing = await tx.submissionVersion.findUnique({
      where: { id: requestId },
      select: { ...versionSelect, requestFingerprint: true, submittedById: true, submission: { select: { assignmentId: true } } },
    });
    if (existing) {
      if (existing.offeringId !== offeringId || existing.submission.assignmentId !== assignmentId
        || existing.submittedById !== access.member.id || !existing.finalizedAt
        || (existing.requestFingerprint ? existing.requestFingerprint !== fingerprint : existing.body !== body || retainedFileIds.length || uploads.length)) {
        throw new DomainError('提交标识已被使用，请重新打开页面后提交。');
      }
      const { submittedById: _submittedById, submission: _submission, requestFingerprint: _fingerprint, ...version } = existing;
      return versionView(version);
    }
    requireWritable(access);
    confirmedSubmission(input);
    // Keep the requirements stable until this submit transaction commits.
    // A concurrent teacher update either precedes this read or waits for it.
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Assignment" WHERE "id" = ${assignmentId} AND "offeringId" = ${offeringId} FOR SHARE`);
    const assignment = await visibleAssignment(tx, access, assignmentId);
    const group = await currentGroup(tx, access);
    const current = (await submissionContext(tx, access, assignment, group))!;
    const reasons: SubmissionConflictReason[] = [];
    if (assignment.mode === 'GROUP' && input.expectedGroupId !== current.confirmation.groupId) reasons.push('group');
    if (input.expectedAssignmentRevision !== current.confirmation.assignmentRevision) reasons.push('requirements');
    if (input.expectedLatestSubmissionToken !== current.confirmation.latestSubmissionToken) reasons.push('latest_submission');
    if (reasons.length) throw new SubmissionConflictError(reasons, current);
    if (!current.canSubmit) throw new DomainError(current.blockedReason!);
    const participantIds = assignment.mode === 'INDIVIDUAL' ? [access.member.id] : (await tx.groupMember.findMany({
      where: {
        offeringId, groupId: group!.id, leftAt: null,
        courseMember: { offeringId, role: 'STUDENT', status: 'ACTIVE' },
      },
      select: { courseMemberId: true },
    })).map(row => row.courseMemberId);
    if (!participantIds.includes(access.member.id)) throw new DomainError('小组成员已变化，请刷新页面后重试。');
    const owner = assignment.mode === 'INDIVIDUAL' ? { courseMemberId: access.member.id } : { groupId: group!.id };
    let submission = await tx.submission.findFirst({ where: { assignmentId, offeringId, ...owner } });
    if (!submission) submission = await tx.submission.create({ data: { offeringId, assignmentId, ...owner } });
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Submission" WHERE "id" = ${submission.id} AND "offeringId" = ${offeringId} FOR SHARE`);
    const latest = await tx.submissionVersion.findFirst({
      where: { submissionId: submission.id }, orderBy: { version: 'desc' }, select: { id: true, version: true, finalizedAt: true },
    });
    const now = new Date();
    const blocked = submissionBlockedReason(access, assignment, group, now, latest?.finalizedAt ? submission.correctionUntil : null);
    if (blocked) throw new DomainError(blocked);
    const retained = retainedFileIds.length && current.latestSubmission
      ? await tx.submissionFile.findMany({ where: {
        offeringId, versionId: current.latestSubmission.id, fileId: { in: retainedFileIds },
      }, select: { fileId: true, file: { select: { sizeBytes: true } } } })
      : [];
    if (retained.length !== retainedFileIds.length) throw new DomainError('只能保留本次更正所依据成果中的附件。');
    if (retained.reduce((total, row) => total + Number(row.file.sizeBytes), uploadBytes) > MAX_SUBMISSION_FILE_BYTES) {
      throw new DomainError('保留与新增附件合计不能超过 10 MiB。');
    }
    const specification = await ensureCurrentRevision(tx, assignment);
    const version = await tx.submissionVersion.create({
      data: { id: requestId, offeringId, submissionId: submission.id, submittedById: access.member.id, version: (latest?.version ?? 0) + 1, body, requestFingerprint: fingerprint, submittedAt: now, assignmentRevisionId: specification.id },
      select: { id: true },
    });
    await tx.submissionParticipant.createMany({
      data: participantIds.map(courseMemberId => ({ offeringId, versionId: version.id, courseMemberId })),
    });
    const uploadedIds: string[] = [];
    for (const file of uploads) {
      const stored = await tx.fileObject.create({ data: {
        offeringId, ownerId: userId, storageKey: randomUUID(), originalName: file.name,
        mimeType: 'application/octet-stream', sizeBytes: file.bytes.length, bytes: Uint8Array.from(file.bytes),
      }, select: { id: true } });
      uploadedIds.push(stored.id);
    }
    const fileIds = [...retainedFileIds, ...uploadedIds];
    if (fileIds.length) await tx.submissionFile.createMany({
      data: fileIds.map(fileId => ({ offeringId, versionId: version.id, fileId })),
    });
    // Seal the submitted content first. Review progress lives in a separate
    // mutable record; it must never rewrite this immutable content snapshot.
    const finalizedAt = new Date();
    const finalBlock = submissionBlockedReason(access, assignment, group, finalizedAt, latest?.finalizedAt ? submission.correctionUntil : null);
    if (finalBlock) throw new DomainError(finalBlock);
    const finalized = await tx.submissionVersion.update({ where: { id: version.id }, data: { finalizedAt }, select: versionSelect });
    await tx.submissionVersionReview.create({ data: { versionId: version.id, offeringId, state: 'PENDING', revision: 1 } });
    await tx.submissionReviewEvent.create({ data: { versionId: version.id, offeringId, revision: 1, state: 'PENDING', actorId: null } });
    return versionView(finalized);
  }, true);
}

export async function addFeedback(userId: string, offeringId: string, versionId: string, body: string) {
  const content = text(body, '反馈内容', 12000);
  return transactional(async tx => {
    const access = await context(tx, userId, offeringId);
    requireWritable(access);
    if (!access.canReview || !access.member) throw new DomainError('请先加入本期教学团队，再以教师或助教身份反馈。');
    const version = await tx.submissionVersion.findFirst({ where: { id: versionId, ...versionVisibility(access) }, select: { id: true } });
    if (!version) throw new DomainError('提交版本不存在或尚未正式提交。');
    return tx.review.create({
      data: { offeringId, versionId: version.id, reviewerId: access.member.id, body: content },
      select: { id: true, body: true, createdAt: true },
    });
  });
}

export class ReviewRevisionConflictError extends DomainError {
  constructor() { super('评阅状态已被更新，请重新核对；本次操作未覆盖。'); }
}

export async function setSubmissionReviewState(userId: string, offeringId: string, versionId: string, input: {
  state: 'PENDING' | 'COMPLETED'; expectedRevision: number;
}) {
  if (!input || !['PENDING', 'COMPLETED'].includes(input.state)
    || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new DomainError('请重新打开提交版本后操作，缺少有效的评阅状态。');
  }
  return transactional(async tx => {
    const access = await context(tx, userId, offeringId);
    requireWritable(access);
    if (!access.canReview || !access.member) throw new DomainError('只有本期在岗教师或助教可以确认评阅状态。');
    const version = await tx.submissionVersion.findFirst({
      where: { id: versionId, ...versionVisibility(access) }, select: { id: true },
    });
    if (!version) throw new DomainError('提交版本不存在或尚未正式提交。');
    const existing = await tx.submissionVersionReview.findUnique({ where: { versionId }, select: { revision: true, state: true } });
    if ((existing?.revision ?? 0) !== input.expectedRevision) throw new ReviewRevisionConflictError();
    if (existing?.state === input.state) return { state: existing.state, revision: existing.revision };
    const revision = input.expectedRevision + 1;
    const changedAt = new Date();
    if (existing) {
      const updated = await tx.submissionVersionReview.updateMany({
        where: { versionId, offeringId, revision: input.expectedRevision },
        data: { state: input.state, revision, updatedById: access.member.id, updatedAt: changedAt },
      });
      if (updated.count !== 1) throw new ReviewRevisionConflictError();
    } else {
      await tx.submissionVersionReview.create({ data: {
        versionId, offeringId, state: input.state, revision, updatedById: access.member.id, updatedAt: changedAt,
      } });
    }
    await tx.submissionReviewEvent.create({ data: {
      versionId, offeringId, revision, state: input.state, actorId: access.member.id, createdAt: changedAt,
    } });
    return { state: input.state, revision };
  }, true);
}

// Only teaching-team reads receive the still-valid authorizations, including
// those paused by cancellation. Keep departed owners available in history.
async function pendingCorrectionAuthorizations(tx: Tx, access: Context, assignmentIds: string[]) {
  if (!access.readAll) return [];
  const rows = await tx.submission.findMany({
    where: { offeringId: access.offering.id, assignmentId: { in: assignmentIds }, correctionUntil: { gt: new Date() },
      versions: { some: { finalizedAt: { not: null } } } },
    select: { id: true, assignmentId: true, correctionUntil: true, correctionRevision: true,
      versions: { where: { finalizedAt: { not: null } }, orderBy: { version: 'desc' }, take: 1, select: { id: true } } },
  });
  return rows.map(row => ({ submissionId: row.id, assignmentId: row.assignmentId, correctionUntil: row.correctionUntil!,
    correctionRevision: row.correctionRevision, latestVersionId: row.versions[0].id }));
}

export async function getAssignmentIndex(userId: string, offeringId: string) {
  return transactional(async tx => {
    const access = await context(tx, userId, offeringId);
    const assignments = (await tx.assignment.findMany({
      where: { offeringId, ...assignmentVisibility(access) },
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { title: 'asc' }, { id: 'asc' }],
      select: assignmentSelect,
    })).map(assignmentView);
    const versions = await tx.submissionVersion.findMany({
      where: { ...versionVisibility(access), submission: { assignmentId: { in: assignments.map(row => row.id) } } },
      orderBy: [{ submittedAt: 'desc' }, { version: 'desc' }, { id: 'desc' }],
      select: { ...versionSelect, submission: { select: { assignmentId: true } } },
    });
    const overview = await assignmentOverview(tx, access, assignments);
    const authorizations = await pendingCorrectionAuthorizations(tx, access, assignments.map(row => row.id));
    return {
      ...publicContext(access),
      assignments: assignments.map(assignment => {
        const visible = versions.filter(version => version.submission.assignmentId === assignment.id);
        const latest = visible[0];
        const latestVersion = latest ? {
          id: latest.id, offeringId: latest.offeringId, submissionId: latest.submissionId,
          version: latest.version, body: latest.body, submittedAt: latest.submittedAt, finalizedAt: latest.finalizedAt,
          assignmentRevisionId: latest.assignmentRevisionId,
          assignmentRevision: latest.assignmentRevision ? revisionView(latest.assignmentRevision) : null,
        } : null;
        const { summary, mineSummary, progress, reviewQueue } = overview.get(assignment.id)!;
        const unassignedSummary = access.isTa && assignment.mode === 'INDIVIDUAL' && access.offering.status !== 'DRAFT'
          && (assignment.status === 'PUBLISHED' || assignment.status === 'ARCHIVED')
          ? summarizeQueue(reviewQueue.filter(row => row.groupId === null)) : null;
        return { ...assignment, versionCount: visible.length, latestVersion, summary, mineSummary, progress,
          unassignedSummary,
          ...(access.readAll ? { pendingCorrectionCount: authorizations.filter(row => row.assignmentId === assignment.id).length } : {}) };
      }),
    };
  });
}

export async function getAssignmentDetail(userId: string, offeringId: string, assignmentId: string) {
  return transactional(async tx => {
    const access = await context(tx, userId, offeringId);
    const assignment = await visibleAssignment(tx, access, assignmentId);
    const group = await currentGroup(tx, access);
    const versions = await tx.submissionVersion.findMany({
      where: { ...versionVisibility(access), submission: { assignmentId } },
      orderBy: [{ submittedAt: 'desc' }, { version: 'desc' }, { id: 'desc' }],
      select: versionSourceSelect,
    });
    const overview = (await assignmentOverview(tx, access, [assignment], group)).get(assignment.id)!;
    const confirmationContext = await submissionContext(tx, access, assignment, group);
    const revisionHistory = await tx.assignmentRevision.findMany({
      where: { assignmentId, offeringId, ...(!access.readAll ? { status: { not: 'DRAFT' as const } } : {}) },
      orderBy: { revision: 'desc' }, select: revisionSelect,
    });
    return {
      ...publicContext(access), assignment,
      correctionAuthorizations: await pendingCorrectionAuthorizations(tx, access, [assignment.id]),
      revisionHistory: revisionHistory.map(revisionView),
      canSubmit: confirmationContext?.canSubmit ?? false, submissionBlockedReason: confirmationContext?.blockedReason ?? null, currentGroup: group,
      submissionContext: confirmationContext,
      ...overview,
      versions: await detailVersions(tx, offeringId, versions),
    };
  });
}

export async function getSubmissionVersion(userId: string, offeringId: string, versionId: string) {
  return transactional(async tx => {
    const access = await context(tx, userId, offeringId);
    const version = await tx.submissionVersion.findFirst({
      where: {
        id: versionId, ...versionVisibility(access),
        submission: { assignment: assignmentVisibility(access) },
      },
      select: versionSourceSelect,
    });
    if (!version) throw new DomainError('提交版本不存在或你没有访问权限。');
    const submission = await tx.submission.findUniqueOrThrow({ where: { id: version.submissionId }, select: { assignmentId: true } });
    const assignment = await visibleAssignment(tx, access, submission.assignmentId);
    return { ...publicContext(access), assignment, version: (await detailVersions(tx, offeringId, [version]))[0] };
  });
}

export async function setSubmissionCorrectionWindow(userId: string, offeringId: string, assignmentId: string, submissionId: string, expectedRevision: number, until: Date | null) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || (until !== null && !Number.isFinite(until.getTime()))) {
    throw new DomainError('请选择有效的更正期限。');
  }
  return transactional(async tx => {
    const access = await context(tx, userId, offeringId);
    if (!access.canReview || access.offering.status !== 'ACTIVE') throw new DomainError('仅进行中课程的教学团队可以管理更正期限。');
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Assignment" WHERE "id" = ${assignmentId} AND "offeringId" = ${offeringId} FOR SHARE`);
    const assignment = await visibleAssignment(tx, access, assignmentId);
    const revokingCancelled = assignment.status === 'CANCELLED' && until === null;
    if (!revokingCancelled && (assignment.status !== 'PUBLISHED' || !assignment.dueAt || assignment.dueAt > new Date())) {
      throw new DomainError('只有已截止且仍发布的作业可以开放指定成果更正。');
    }
    if (until && until <= new Date()) throw new DomainError('更正期限须晚于当前时间。');
    const submission = await tx.submission.findFirst({
      where: { id: submissionId, offeringId, assignmentId, versions: { some: { finalizedAt: { not: null } } } },
      select: { correctionRevision: true, correctionUntil: true },
    });
    if (!submission) throw new DomainError('只能为这项作业已交的成果开放更正。');
    if (submission.correctionRevision !== expectedRevision) throw new DomainError('更正期限已更新，请刷新后核对。');
    if (revokingCancelled && !submission.correctionUntil) throw new DomainError('这份成果没有可撤销的更正授权。');
    if (submission.correctionUntil?.getTime() === until?.getTime()) return;
    const revision = expectedRevision + 1;
    const changed = await tx.submission.updateMany({
      where: { id: submissionId, offeringId, assignmentId, correctionRevision: expectedRevision },
      data: { correctionUntil: until, correctionRevision: revision },
    });
    if (!changed.count) throw new DomainError('更正期限已更新，请刷新后核对。');
    await tx.submissionCorrectionEvent.create({ data: { offeringId, submissionId, revision, until, actorUserId: userId } });
  });
}

export async function getSubmissionAttachment(userId: string, offeringId: string, assignmentId: string, versionId: string, fileId: string) {
  return transactional(async tx => {
    const access = await context(tx, userId, offeringId);
    const file = await tx.submissionFile.findFirst({
      where: { offeringId, versionId, fileId, version: {
        ...versionVisibility(access), submission: { assignmentId, assignment: assignmentVisibility(access) },
      } },
      select: { file: { select: { originalName: true, bytes: true } } },
    });
    return file?.file.bytes ? { name: file.file.originalName, bytes: file.file.bytes } : null;
  });
}
