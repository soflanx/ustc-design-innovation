import type { AssignmentMode, ContentStatus, TermStatus } from '@prisma/client';
import type { AssignmentProgress, AssignmentSummary } from './teaching';

export type AssignmentHomeAudience = 'STUDENT' | 'TEACHER' | 'TA' | 'ADMIN';

export type AssignmentHomeSource = {
  id: string;
  offeringId: string;
  title: string;
  mode: AssignmentMode;
  status: ContentStatus;
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
  statusLabel: string;
  actionLabel: string;
  href: string;
  actionable: boolean;
};

export function progressLabel(progress: AssignmentProgress | null | undefined, mode: AssignmentMode) {
  if (!progress) return '暂无提交记录';
  if (progress.state === 'UNGROUPED') return '尚未分组，请联系教师';
  if (progress.state === 'NOT_SUBMITTED') return mode === 'GROUP' ? '当前小组暂无你的提交记录' : '尚未提交';
  if (progress.state === 'FEEDBACK_AVAILABLE') return `已有 ${progress.feedbackCount} 条反馈`;
  return '已提交 · 待反馈';
}

export function summaryLabel(summary: AssignmentSummary | null | undefined, mode: AssignmentMode, scope: 'all' | 'mine' = 'all') {
  if (!summary) return '';
  return `${scope === 'mine' ? '我负责范围' : '全班'}已交 ${summary.submittedCount}/${summary.totalExpectedCount} ${mode === 'GROUP' ? '组' : '人'} · 待反馈 ${summary.pendingFeedbackCount}`;
}

function assignmentHome(
  assignment: AssignmentHomeSource,
  context: AssignmentHomeContext,
  now: Date,
): AssignmentHomePresentation {
  const basePath = `/courses/${assignment.offeringId}`;
  const assignmentPath = `${basePath}/assignments/${assignment.id}`;
  const { audience, offeringStatus } = context;
  const expired = !!assignment.dueAt && assignment.dueAt.getTime() <= now.getTime();
  const open = offeringStatus === 'ACTIVE' && assignment.status === 'PUBLISHED' && !expired;
  const closedLabel = assignment.status === 'ARCHIVED' ? '作业已结束' : expired ? '已截止' : '尚未开放提交';
  const feedbackPath = assignment.progress?.state === 'FEEDBACK_AVAILABLE' && assignment.progress.latestVersionId
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
        priority: 0, statusLabel: '尚未分组，请联系教师', actionLabel: '查看教学团队',
        href: `${basePath}/team`, actionable: true,
      };
    }
    if (progress?.state === 'NOT_SUBMITTED') {
      return {
        priority: 0, statusLabel: progressLabel(progress, assignment.mode), actionLabel: '去提交作业',
        href: `${assignmentPath}#submission`, actionable: true,
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
        actionLabel: '查看负责范围待反馈', href: `${assignmentPath}?view=pending&scope=mine`, actionable: true,
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
      actionLabel: '查看待反馈', href: `${assignmentPath}?view=pending&scope=all`, actionable: true,
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
  return assignments.map(assignment => ({ ...assignment, home: assignmentHome(assignment, context, now) }))
    .sort((a, b) => {
      const priority = a.home.priority - b.home.priority;
      if (priority) return priority;
      const aDeadline = deadline(a); const bDeadline = deadline(b);
      if (aDeadline !== bDeadline) return aDeadline < bDeadline ? -1 : 1;
      return a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id);
    });
}
