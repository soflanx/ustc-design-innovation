import type { AssignmentMode, AssignmentStatus, TermStatus } from '@prisma/client';
import type { AssignmentProgress, AssignmentReviewQueueItem, AssignmentSummary } from './teaching';

export const reviewStateLabels = { PENDING: '待评阅', COMPLETED: '本轮评阅已完成', LEGACY_UNKNOWN: '历史评阅状态未确认' };

export const assignmentReviewViews = {
  latest: '已交', missing: '未交', pending: '待评阅', completed: '已评阅', unconfirmed: '历史待核对', history: '更正历史',
};
export type AssignmentReviewView = keyof typeof assignmentReviewViews;
export type AssignmentReviewScope = 'mine' | 'all' | 'unassigned';

export function getAssignmentStatistics(
  assignment: { mode: AssignmentMode; status: AssignmentStatus; dueAt: Date | null },
  queue: readonly AssignmentReviewQueueItem[],
  { scope, offeringStatus, now = new Date() }: { scope: AssignmentReviewScope; offeringStatus: TermStatus; now?: Date },
) {
  const hasSubmissionRequirement = assignment.status !== 'CANCELLED' && assignment.status !== 'DRAFT' && offeringStatus !== 'DRAFT';
  const isOverdue = assignment.status === 'PUBLISHED' && offeringStatus === 'ACTIVE'
    && assignment.dueAt !== null && assignment.dueAt <= now;
  const missingLabel = hasSubmissionRequirement ? (isOverdue ? '逾期未交' : '未交') : null;
  const unassigned = assignment.mode === 'INDIVIDUAL'
    ? queue.filter(row => row.groupId === null && (hasSubmissionRequirement || row.latestVersionId !== null)) : [];
  const owners = scope === 'mine' ? queue.filter(row => row.assignedToMe) : scope === 'unassigned' ? unassigned : queue;
  const submitted = owners.filter(row => row.latestVersionId !== null);
  return {
    ownerCount: hasSubmissionRequirement ? owners.length : null,
    unassignedCount: unassigned.length,
    missingLabel,
    rows: {
      latest: submitted,
      missing: missingLabel ? owners.filter(row => row.latestVersionId === null) : [],
      pending: submitted.filter(row => row.reviewState === 'PENDING'),
      completed: submitted.filter(row => row.reviewState === 'COMPLETED'),
      unconfirmed: submitted.filter(row => row.reviewState === 'LEGACY_UNKNOWN'),
    },
  };
}

export type AssignmentHomeAudience = 'STUDENT' | 'TEACHER' | 'TA' | 'ADMIN';

export type AssignmentHomeSource = {
  id: string;
  offeringId: string;
  title: string;
  mode: AssignmentMode;
  status: AssignmentStatus;
  dueAt: Date | null;
  summary?: AssignmentSummary | null;
  mineSummary?: AssignmentSummary | null;
  progress?: AssignmentProgress | null;
};

export type AssignmentHomeContext = {
  audience: AssignmentHomeAudience;
  offeringStatus: TermStatus;
  now?: Date;
};

export type AssignmentHomePresentation = {
  priority: number;
  /** Publication and submission lifecycle, independent of the viewer's progress or feedback scope. */
  lifecycleLabel: string;
  /** Short public state suitable for a reference in running text. */
  lifecycleHint: string;
  statusLabel: string;
  actionLabel: string;
  href: string;
  /** A student can read the brief before following the separate submit action. */
  readHref?: string;
  actionable: boolean;
};

export function progressLabel(progress: AssignmentProgress | null | undefined, mode: AssignmentMode) {
  if (!progress) return '暂无提交记录';
  if (progress.state === 'CANCELLED') return '已取消，不再要求完成';
  if (progress.state === 'UNGROUPED') return '尚未分组';
  if (progress.state === 'NOT_SUBMITTED') return mode === 'GROUP' ? '当前小组尚未提交' : '尚未提交';
  if (progress.state === 'FEEDBACK_AVAILABLE') return `已有 ${progress.feedbackCount} 条反馈${progress.reviewState === 'COMPLETED' ? ' · 本轮评阅已完成' : progress.reviewState === 'PENDING' ? ' · 待评阅' : progress.reviewState === 'LEGACY_UNKNOWN' ? ' · 历史评阅状态未确认' : ''}`;
  if (progress.reviewState === 'COMPLETED') return '已提交 · 本轮评阅已完成';
  if (progress.reviewState === 'LEGACY_UNKNOWN') return '已提交 · 历史评阅状态未确认';
  return '已提交 · 待评阅';
}

export function summaryLabel(summary: AssignmentSummary | null | undefined, mode: AssignmentMode, scope: 'all' | 'mine' = 'all') {
  if (!summary) return '';
  return `${scope === 'mine' ? '我负责范围' : '全班'}已交 ${summary.submittedCount}/${summary.totalExpectedCount} ${mode === 'GROUP' ? '组' : '人'} · 待评阅 ${summary.pendingFeedbackCount}${summary.unknownReviewCount ? ` · 历史待核对 ${summary.unknownReviewCount}` : ''}`;
}

export function assignmentLifecycle(assignment: Pick<AssignmentHomeSource, 'status' | 'dueAt'>, offeringStatus: TermStatus, now: Date) {
  // An unpublished assignment stays private even if its course is archived.
  if (assignment.status === 'DRAFT') return { lifecycleLabel: '草稿 · 学生不可见', lifecycleHint: '草稿' };
  if (assignment.status === 'CANCELLED') return { lifecycleLabel: '已取消，不再要求完成', lifecycleHint: '已取消，免交' };
  if (offeringStatus === 'ARCHIVED') return { lifecycleLabel: '课程已归档 · 记录只读', lifecycleHint: '课程已归档' };
  if (assignment.status === 'ARCHIVED') return { lifecycleLabel: '已结束 · 停止提交，可查看已有反馈', lifecycleHint: '作业已结束' };
  if (assignment.dueAt && assignment.dueAt.getTime() <= now.getTime()) return { lifecycleLabel: '已截止 · 停止提交，可查看已有反馈', lifecycleHint: '已截止' };
  if (offeringStatus === 'DRAFT') return { lifecycleLabel: '已发布 · 课程筹备中，暂不接受提交', lifecycleHint: '暂未开放提交' };
  return { lifecycleLabel: '已发布 · 接受提交', lifecycleHint: '可提交' };
}

function assignmentHome(
  assignment: AssignmentHomeSource,
  context: AssignmentHomeContext,
  now: Date,
): Omit<AssignmentHomePresentation, 'lifecycleLabel' | 'lifecycleHint'> {
  const basePath = `/courses/${assignment.offeringId}`;
  const assignmentPath = `${basePath}/assignments/${assignment.id}`;
  const { audience, offeringStatus } = context;
  const expired = !!assignment.dueAt && assignment.dueAt.getTime() <= now.getTime();
  const open = offeringStatus === 'ACTIVE' && assignment.status === 'PUBLISHED' && !expired;
  const closedLabel = assignment.status === 'ARCHIVED' ? '作业已结束' : expired ? '已截止' : '尚未开放提交';
  const feedbackPath = (assignment.progress?.feedbackCount ?? 0) > 0 && assignment.progress?.latestVersionId
    ? `${assignmentPath}#version-${assignment.progress.latestVersionId}` : assignmentPath;

  // Course archival overrides all urgency and write-oriented calls to action.
  if (offeringStatus === 'ARCHIVED') {
    return {
      priority: 100,
      statusLabel: '课程已归档 · 记录只读',
      actionLabel: '查看记录',
      href: audience === 'TA' ? `${assignmentPath}?view=latest&scope=mine` : feedbackPath,
      actionable: false,
    };
  }

  // Cancellation removes the requirement and urgency while retaining the record.
  if (assignment.status === 'CANCELLED') {
    const hasFeedback = audience === 'STUDENT' && (assignment.progress?.feedbackCount ?? 0) > 0;
    return {
      priority: 20,
      statusLabel: `已取消，不再要求完成${hasFeedback ? ` · 已有 ${assignment.progress!.feedbackCount} 条反馈` : ''}`,
      actionLabel: audience === 'ADMIN' ? '管理作业' : hasFeedback ? '查看已有反馈' : '查看记录',
      href: audience === 'ADMIN' ? `${basePath}/assignments?edit=${assignment.id}#edit-${assignment.id}`
        : audience === 'TA' ? `${assignmentPath}?view=latest&scope=mine` : feedbackPath,
      actionable: false,
    };
  }

  if (audience === 'STUDENT') {
    const progress = assignment.progress;
    // Feedback often arrives after submission closes. Keep it after open
    // submissions but ahead of records still waiting for feedback.
    if (offeringStatus === 'ACTIVE' && progress?.state === 'FEEDBACK_AVAILABLE') {
      return {
        priority: 1,
        statusLabel: `${open ? '' : `${closedLabel} · `}${progressLabel(progress, assignment.mode)}`,
        actionLabel: '查看已有反馈', href: feedbackPath, actionable: true,
      };
    }
    if (offeringStatus === 'ACTIVE' && progress?.state === 'SUBMITTED') {
      return {
        priority: 2,
        statusLabel: `${open ? '' : `${closedLabel} · `}${progressLabel(progress, assignment.mode)}`,
        actionLabel: '查看作业', href: assignmentPath, actionable: false,
      };
    }
    if (!open) {
      return {
        priority: 10,
        statusLabel: offeringStatus === 'DRAFT' ? '课程筹备中 · 尚未开放提交'
          : `${closedLabel} · ${progressLabel(progress, assignment.mode)}`,
        actionLabel: progress?.state === 'FEEDBACK_AVAILABLE' ? '查看已有反馈' : '查看作业',
        href: feedbackPath,
        actionable: false,
      };
    }
    if (progress?.state === 'UNGROUPED') {
      return {
        priority: 0, statusLabel: progressLabel(progress, assignment.mode), actionLabel: '查看组队安排',
        href: `${basePath}/groups`, readHref: assignmentPath, actionable: true,
      };
    }
    if (progress?.state === 'NOT_SUBMITTED') {
      return {
        priority: 0, statusLabel: progressLabel(progress, assignment.mode), actionLabel: '去提交作业',
        href: `${assignmentPath}#submission`, readHref: assignmentPath, actionable: true,
      };
    }
    return {
      priority: 3,
      statusLabel: progressLabel(progress, assignment.mode), actionLabel: '查看作业',
      href: assignmentPath, actionable: false,
    };
  }

  if (audience === 'ADMIN') {
    const summary = assignment.summary;
    const statusLabel = assignment.status === 'DRAFT' ? '作业草稿'
      : `${assignment.status === 'ARCHIVED' ? '作业已结束' : expired ? '已截止' : '已发布'}${summary ? ` · 全班已交 ${summary.submittedCount}/${summary.totalExpectedCount} ${assignment.mode === 'GROUP' ? '组' : '人'}` : ''}`;
    return {
      priority: assignment.status === 'DRAFT' ? 0 : open ? 1 : 2,
      statusLabel, actionLabel: '管理作业', href: `${basePath}/assignments?edit=${assignment.id}#edit-${assignment.id}`,
      actionable: assignment.status === 'DRAFT',
    };
  }

  if (audience === 'TA') {
    const summary = assignment.mineSummary;
    const href = `${assignmentPath}?view=latest&scope=mine`;
    if (!summary || summary.totalExpectedCount === 0) {
      return {
        priority: 5, statusLabel: '当前负责范围没有应交学生或小组', actionLabel: '查看负责范围',
        href, actionable: false,
      };
    }
    if (summary.pendingFeedbackCount > 0) {
      return {
        priority: 0, statusLabel: summaryLabel(summary, assignment.mode, 'mine'),
        actionLabel: '查看负责范围待评阅', href: `${assignmentPath}?view=pending&scope=mine`, actionable: true,
      };
    }
    return {
      priority: open ? 2 : assignment.status === 'DRAFT' ? 4 : 3,
      statusLabel: summaryLabel(summary, assignment.mode, 'mine'),
      actionLabel: '查看负责范围', href, actionable: false,
    };
  }

  // Submission deadlines and assignment closure do not close teacher feedback.
  if ((assignment.summary?.pendingFeedbackCount ?? 0) > 0) {
    return {
      priority: 0, statusLabel: summaryLabel(assignment.summary, assignment.mode),
      actionLabel: '查看待评阅', href: `${assignmentPath}?view=pending&scope=all`, actionable: true,
    };
  }
  if (assignment.status === 'DRAFT') {
    return {
      priority: 1, statusLabel: '作业草稿 · 尚未发布', actionLabel: '管理作业草稿',
      href: `${basePath}/assignments?edit=${assignment.id}#edit-${assignment.id}`, actionable: true,
    };
  }
  return {
    priority: open ? 2 : 3, statusLabel: summaryLabel(assignment.summary, assignment.mode),
    actionLabel: '查看提交', href: assignmentPath, actionable: false,
  };
}

/** Pure, stable ordering shared by course pages, course cards, and assignment lists. */
export function getAssignmentHomeItems<T extends AssignmentHomeSource>(
  assignments: readonly T[],
  context: AssignmentHomeContext,
): Array<T & { home: AssignmentHomePresentation }> {
  const now = context.now ?? new Date();
  const deadline = (assignment: T) => assignment.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return assignments.map(assignment => ({ ...assignment, home: {
    ...assignmentHome(assignment, context, now),
    ...assignmentLifecycle(assignment, context.offeringStatus, now),
  } }))
    .sort((a, b) => {
      const priority = a.home.priority - b.home.priority;
      if (priority) return priority;
      const aDeadline = deadline(a); const bDeadline = deadline(b);
      if (aDeadline !== bDeadline) return aDeadline < bDeadline ? -1 : 1;
      return a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id);
    });
}
