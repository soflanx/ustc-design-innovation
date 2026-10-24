import { Prisma, type AssignmentMode, type ContentStatus } from '@prisma/client';
import { db } from './db';
import { DomainError } from './management';
import { canManageOffering, canViewOffering } from './policy';

type Tx = Prisma.TransactionClient;

export type AssignmentInput = {
  title: string;
  description: string;
  mode: AssignmentMode;
  status: ContentStatus;
  dueAt: Date | null;
};

export type AssignmentSummary = {
  submittedCount: number;
  pendingFeedbackCount: number;
  feedbackCount: number;
  totalExpectedCount: number;
};

export type AssignmentProgress = {
  state: 'UNGROUPED' | 'NOT_SUBMITTED' | 'SUBMITTED' | 'FEEDBACK_AVAILABLE';
  latestVersionId: string | null;
  feedbackCount: number;
};

export type AssignmentReviewQueueItem = {
  id: string;
  ownerLabel: string;
  groupId: string | null;
  latestVersionId: string | null;
  latestVersionNumber: number | null;
  submittedAt: Date | null;
  feedbackCount: number;
  assignedToMe: boolean;
};

type AssignmentOverview = {
  summary: AssignmentSummary | null;
  mineSummary: AssignmentSummary | null;
  progress: AssignmentProgress | null;
  reviewQueue: AssignmentReviewQueueItem[];
};

const assignmentSelect = {
  id: true, offeringId: true, title: true, description: true,
  mode: true, status: true, dueAt: true,
} satisfies Prisma.AssignmentSelect;

const versionSelect = {
  id: true, offeringId: true, submissionId: true, version: true,
  body: true, submittedAt: true, finalizedAt: true,
} satisfies Prisma.SubmissionVersionSelect;

const versionSourceSelect = { ...versionSelect, submittedById: true } satisfies Prisma.SubmissionVersionSelect;
type VersionSource = Prisma.SubmissionVersionGetPayload<{ select: typeof versionSourceSelect }>;
type AssignmentView = Prisma.AssignmentGetPayload<{ select: typeof assignmentSelect }>;

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
  if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(input.status)) throw new DomainError('请选择有效的作业状态。');
  if (input.dueAt !== null && (!(input.dueAt instanceof Date) || !Number.isFinite(input.dueAt.getTime()))) {
    throw new DomainError('请填写有效的截止时间，或留空。');
  }
  return {
    title: text(input.title, '作业标题', 100),
    description: text(input.description, '作业说明', 12000, false),
    mode: input.mode,
    status: input.status,
    dueAt: input.dueAt,
  };
}

async function transactional<T>(work: (tx: Tx) => Promise<T>, retryUnique = false): Promise<T> {
  // Concurrent first submissions can race on the owner key; later versions can
  // race on their version number. Always retry the entire authorization/snapshot.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const retry = error instanceof Prisma.PrismaClientKnownRequestError
        && (error.code === 'P2034' || (retryUnique && error.code === 'P2002'));
      if (!retry) throw error;
      if (attempt === 4) throw new DomainError('提交正在更新，请稍后重试；请保留当前表单。');
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 10));
    }
  }
  throw new DomainError('数据正在更新，请重试。');
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
  return access.readAll ? {} : { status: { in: ['PUBLISHED', 'ARCHIVED'] } };
}

function versionVisibility(access: Context): Prisma.SubmissionVersionWhereInput {
  return {
    offeringId: access.offering.id,
    finalizedAt: { not: null },
    // Never infer historical access from the student's current group.
    ...(!access.readAll ? {
      OR: [
        { participants: { some: { courseMemberId: access.member!.id } } },
        { submission: { courseMemberId: access.member!.id } },
      ],
    } : {}),
  };
}

async function visibleAssignment(tx: Tx, access: Context, assignmentId: string) {
  const assignment = await tx.assignment.findFirst({
    where: { id: assignmentId, offeringId: access.offering.id, ...assignmentVisibility(access) },
    select: assignmentSelect,
  });
  if (!assignment) throw new DomainError('作业不存在或你没有访问权限。');
  return assignment;
}

async function detailVersions(tx: Tx, offeringId: string, rows: VersionSource[]) {
  const versionIds = rows.map(row => row.id);
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
  const memberIds = new Set([
    ...rows.map(row => row.submittedById),
    ...participants.map(row => row.courseMemberId),
    ...reviews.map(row => row.reviewerId),
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
  return rows.map(({ submittedById, ...version }) => {
    const submitter = memberMap.get(submittedById)!;
    const submission = submissionMap.get(version.submissionId)!;
    return {
      ...version,
      submittedBy: { id: submitter.id, name: submitter.name },
      participants: participants.filter(row => row.versionId === version.id).map(row => {
        const member = memberMap.get(row.courseMemberId)!;
        return { id: member.id, name: member.name };
      }),
      ownerLabel: submission.groupId ? groupMap.get(submission.groupId)!.name : memberMap.get(submission.courseMemberId!)!.name,
      feedback: reviews.filter(row => row.versionId === version.id).map(({ reviewerId, versionId: _versionId, ...review }) => ({
        ...review, reviewer: memberMap.get(reviewerId)!,
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
    pendingFeedbackCount: queue.filter(row => row.latestVersionId !== null && row.feedbackCount === 0).length,
    // Count owners with feedback, rather than individual feedback comments.
    feedbackCount: queue.filter(row => row.latestVersionId !== null && row.feedbackCount > 0).length,
  };
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
    select: { id: true, assignmentId: true, courseMemberId: true, groupId: true },
  });
  const latestVersions = await tx.submissionVersion.findMany({
    where: {
      offeringId, submissionId: { in: submissions.map(row => row.id) }, finalizedAt: { not: null },
      // Progress is stricter than historical personal ownership: it requires
      // the student's actual participation snapshot in the current owner.
      ...(!access.readAll ? { participants: { some: { courseMemberId: access.member!.id } } } : {}),
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
  const latestBySubmission = new Map(latestVersions.map(row => [row.submissionId, row]));
  const feedbackByVersion = new Map(reviewCounts.map(row => [row.versionId, row._count._all]));

  if (!access.readAll) {
    for (const assignment of assignments) {
      const owner = submissions.find(row => row.assignmentId === assignment.id
        && (assignment.mode === 'INDIVIDUAL' ? row.courseMemberId === access.member!.id : row.groupId === group?.id));
      const latest = owner ? latestBySubmission.get(owner.id) : undefined;
      const feedbackCount = latest ? feedbackByVersion.get(latest.id) ?? 0 : 0;
      overview.set(assignment.id, {
        summary: null,
        mineSummary: null,
        reviewQueue: [],
        progress: {
          state: assignment.mode === 'GROUP' && !group ? 'UNGROUPED'
            : !latest ? 'NOT_SUBMITTED' : feedbackCount ? 'FEEDBACK_AVAILABLE' : 'SUBMITTED',
          latestVersionId: latest?.id ?? null,
          feedbackCount,
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
      return {
        ...owner,
        latestVersionId: latest?.id ?? null,
        latestVersionNumber: latest?.version ?? null,
        submittedAt: latest?.submittedAt ?? null,
        feedbackCount: latest ? feedbackByVersion.get(latest.id) ?? 0 : 0,
        assignedToMe: owner.groupId !== null && assignedGroups.has(owner.groupId),
      };
    });
    overview.set(assignment.id, {
      summary: summarizeQueue(reviewQueue),
      mineSummary: access.isTa ? summarizeQueue(reviewQueue.filter(row => row.assignedToMe)) : null,
      progress: null,
      reviewQueue,
    });
  }
  return overview;
}

function submissionBlockedReason(access: Context, assignment: AssignmentView, group: { id: string } | null, now: Date) {
  if (access.offering.status === 'ARCHIVED') return '本期课程已归档，仅可阅读已有记录。';
  if (access.offering.status !== 'ACTIVE') return '课程尚未开放提交。';
  if (access.member?.role !== 'STUDENT' || access.member.status !== 'ACTIVE') return '仅本期在读学生可以提交作业。';
  if (assignment.status !== 'PUBLISHED') return assignment.status === 'ARCHIVED' ? '本作业已结束，仅可阅读已有记录。' : '本作业尚未发布。';
  if (assignment.dueAt && now >= assignment.dueAt) return '已超过作业截止时间，不能继续提交。';
  if (assignment.mode === 'GROUP' && !group) return '请先由教师将你加入本期小组。';
  return null;
}

export async function createAssignment(userId: string, offeringId: string, input: AssignmentInput) {
  const data = assignmentInput(input);
  if (data.status === 'ARCHIVED') throw new DomainError('新作业须先保存为草稿或发布。');
  return transactional(async tx => {
    requireManager(await context(tx, userId, offeringId));
    return tx.assignment.create({ data: { ...data, offeringId }, select: assignmentSelect });
  });
}

export async function updateAssignment(userId: string, offeringId: string, assignmentId: string, input: AssignmentInput) {
  const data = assignmentInput(input);
  return transactional(async tx => {
    const access = await context(tx, userId, offeringId);
    requireManager(access);
    const assignment = await visibleAssignment(tx, access, assignmentId);
    if (assignment.status === 'DRAFT' && data.status === 'ARCHIVED') throw new DomainError('未发布的草稿不能直接结束，请先发布。');
    if (assignment.status !== 'DRAFT' && data.status === 'DRAFT') throw new DomainError('已发布作业不能退回草稿；可结束作业并保留学生记录。');
    if (assignment.mode !== data.mode && await tx.submission.count({ where: { assignmentId, offeringId } })) {
      throw new DomainError('已有提交的作业不能更改个人或小组模式。');
    }
    return tx.assignment.update({ where: { id: assignment.id }, data, select: assignmentSelect });
  });
}

export async function submitAssignment(userId: string, offeringId: string, assignmentId: string, input: {
  body: string;
  requestId: string;
  expectedGroupId?: string | null;
}) {
  const body = text(input?.body, '提交内容', 12000);
  if (typeof input?.requestId !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(input.requestId)) {
    throw new DomainError('提交标识无效，请重新打开作业页面。');
  }
  const requestId = input.requestId.toLowerCase();
  return transactional(async tx => {
    const access = await context(tx, userId, offeringId);
    requireWritable(access);
    if (access.member?.role !== 'STUDENT' || access.member.status !== 'ACTIVE') throw new DomainError('仅本期在读学生可以提交作业。');
    const assignment = await visibleAssignment(tx, access, assignmentId);
    // A successful request may be retried after the deadline or a group move.
    // Only its original author, assignment, and identical normalized text match.
    const existing = await tx.submissionVersion.findUnique({
      where: { id: requestId },
      select: { ...versionSelect, submittedById: true, submission: { select: { assignmentId: true } } },
    });
    if (existing) {
      if (existing.offeringId !== offeringId || existing.submission.assignmentId !== assignmentId
        || existing.submittedById !== access.member.id || existing.body !== body || !existing.finalizedAt) {
        throw new DomainError('提交标识已被使用，请重新打开页面后提交。');
      }
      const { submittedById: _submittedById, submission: _submission, ...version } = existing;
      return version;
    }
    const group = await currentGroup(tx, access);
    if (assignment.mode === 'GROUP' && input.expectedGroupId !== (group?.id ?? null)) {
      throw new DomainError('小组已变化，请刷新确认后再提交；正文仍在草稿中。');
    }
    const blocked = submissionBlockedReason(access, assignment, group, new Date());
    if (blocked) throw new DomainError(blocked);
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
    const latest = await tx.submissionVersion.findFirst({
      where: { submissionId: submission.id }, orderBy: { version: 'desc' }, select: { version: true },
    });
    const now = new Date();
    if (assignment.dueAt && now >= assignment.dueAt) throw new DomainError('已超过作业截止时间，不能继续提交。');
    const version = await tx.submissionVersion.create({
      data: { id: requestId, offeringId, submissionId: submission.id, submittedById: access.member.id, version: (latest?.version ?? 0) + 1, body, submittedAt: now },
      select: { id: true },
    });
    await tx.submissionParticipant.createMany({
      data: participantIds.map(courseMemberId => ({ offeringId, versionId: version.id, courseMemberId })),
    });
    // Sealing comes last: database triggers then make this version and snapshot immutable.
    return tx.submissionVersion.update({ where: { id: version.id }, data: { finalizedAt: now }, select: versionSelect });
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

export async function getAssignmentIndex(userId: string, offeringId: string) {
  return transactional(async tx => {
    const access = await context(tx, userId, offeringId);
    const assignments = await tx.assignment.findMany({
      where: { offeringId, ...assignmentVisibility(access) },
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { title: 'asc' }, { id: 'asc' }],
      select: assignmentSelect,
    });
    const versions = await tx.submissionVersion.findMany({
      where: { ...versionVisibility(access), submission: { assignmentId: { in: assignments.map(row => row.id) } } },
      orderBy: [{ submittedAt: 'desc' }, { version: 'desc' }, { id: 'desc' }],
      select: { ...versionSelect, submission: { select: { assignmentId: true } } },
    });
    const overview = await assignmentOverview(tx, access, assignments);
    return {
      ...publicContext(access),
      assignments: assignments.map(assignment => {
        const visible = versions.filter(version => version.submission.assignmentId === assignment.id);
        const latest = visible[0];
        const latestVersion = latest ? {
          id: latest.id, offeringId: latest.offeringId, submissionId: latest.submissionId,
          version: latest.version, body: latest.body, submittedAt: latest.submittedAt, finalizedAt: latest.finalizedAt,
        } : null;
        const { summary, mineSummary, progress } = overview.get(assignment.id)!;
        return { ...assignment, versionCount: visible.length, latestVersion, summary, mineSummary, progress };
      }),
    };
  });
}

export async function getAssignmentDetail(userId: string, offeringId: string, assignmentId: string) {
  return transactional(async tx => {
    const access = await context(tx, userId, offeringId);
    const assignment = await visibleAssignment(tx, access, assignmentId);
    const group = await currentGroup(tx, access);
    const blocked = submissionBlockedReason(access, assignment, group, new Date());
    const versions = await tx.submissionVersion.findMany({
      where: { ...versionVisibility(access), submission: { assignmentId } },
      orderBy: [{ submittedAt: 'desc' }, { version: 'desc' }, { id: 'desc' }],
      select: versionSourceSelect,
    });
    const overview = (await assignmentOverview(tx, access, [assignment], group)).get(assignment.id)!;
    return {
      ...publicContext(access), assignment,
      canSubmit: blocked === null, submissionBlockedReason: blocked, currentGroup: group,
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
