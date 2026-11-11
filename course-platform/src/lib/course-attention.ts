import {
  getAssignmentHomeItems,
  type AssignmentHomeContext,
  type AssignmentHomePresentation,
  type AssignmentHomeSource,
} from './teaching-presentation';

/**
 * Supplement the current teaching content with other actionable course work.
 * Callers must provide assignments already filtered by the viewer's access.
 */
export function getCourseAttentionItems<T extends AssignmentHomeSource>(
  assignments: readonly T[],
  selectedAssignmentIds: readonly string[],
  context: AssignmentHomeContext,
): Array<T & { home: AssignmentHomePresentation }> {
  if (context.offeringStatus !== 'ACTIVE' || context.audience === 'ADMIN') return [];

  const selected = new Set(selectedAssignmentIds);
  const otherAssignments = assignments.filter(assignment => !selected.has(assignment.id)
    && assignment.status !== 'DRAFT' && assignment.status !== 'CANCELLED');
  return getAssignmentHomeItems(otherAssignments, context).filter(assignment => {
    // Reuse deadline, submission-state, and responsible-scope rules from the
    // existing presentation layer instead of creating a second urgency model.
    if (!assignment.home.actionable) return false;
    if (context.audience === 'STUDENT') {
      return assignment.progress?.state === 'NOT_SUBMITTED'
        || assignment.progress?.state === 'UNGROUPED'
        || assignment.progress?.state === 'FEEDBACK_AVAILABLE';
    }
    const summary = context.audience === 'TA' ? assignment.mineSummary : assignment.summary;
    return (summary?.pendingFeedbackCount ?? 0) > 0;
  });
}
