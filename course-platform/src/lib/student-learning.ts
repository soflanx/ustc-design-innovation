import { Prisma, type AssignmentMode, type AssignmentStatus, type TermStatus } from '@prisma/client';
import { db } from './db';
import { DomainError } from './management';
import { studentSubmissionVersionVisibility, type AssignmentProgress } from './teaching';

export type StudentLearningPerson = { id: string; name: string };
export type StudentLearningVersion = {
  id: string; version: number; submittedAt: Date; body: string; href: string;
  submittedBy: StudentLearningPerson; participants: StudentLearningPerson[];
  attachments: { id: string; name: string; size: number; href: string }[];
  feedback: { id: string; body: string; createdAt: Date; author: StudentLearningPerson }[];
};
export type StudentLearningResult = {
  submissionId: string; assignmentId: string; title: string; status: AssignmentStatus;
  mode: AssignmentMode; groupId: string | null; groupName: string | null;
  versions: StudentLearningVersion[];
};
export type StudentLearningAssignment = {
  id: string; title: string; mode: AssignmentMode; dueAt: Date | null;
  progress: AssignmentProgress; canSubmit: boolean; blockedReason: string | null; correctionUntil: Date | null;
  currentVersion: { id: string; hasParticipated: boolean; submittedAt: Date; submittedByName: string; groupName: string | null } | null;
};
export type StudentLearningGuidance = {
  id: string; href: string; body: string; context: string; createdAt: Date; author: StudentLearningPerson;
  groupId: string | null; groupName: string | null;
  recipientBasis: 'PERSONAL' | 'RECEIVED_GROUP' | 'CURRENT_GROUP_SHARED';
  hasResultContext: boolean;
  result: { id: string; assignmentId: string; title: string; href: string } | null;
};
export type StudentLearning = {
  offering: { id: string; status: TermStatus };
  member: StudentLearningPerson;
  currentGroup: { id: string; name: string; href: string } | null;
  currentAssignments: StudentLearningAssignment[];
  participatedResults: StudentLearningResult[];
  guidance: StudentLearningGuidance[];
  groupHistory: { id: string; groupId: string; groupName: string; joinedAt: Date; leftAt: Date | null }[];
};

/** Student-owned view: shared access and historical participation are distinct. */
export async function getStudentLearning(userId: string, offeringId: string): Promise<StudentLearning> {
  return db.$transaction(async tx => {
    const member = await tx.courseMember.findUnique({
      where: { offeringId_userId: { offeringId, userId } },
      select: { id: true, role: true, status: true, user: { select: { name: true } },
        offering: { select: { id: true, status: true } } },
    });
    if (!member || member.role !== 'STUDENT' || member.status !== 'ACTIVE') {
      throw new DomainError('你没有访问本期学生学习记录的权限。');
    }
    const base = `/courses/${encodeURIComponent(offeringId)}`;
    const assignmentPath = (id: string) => `${base}/assignments/${encodeURIComponent(id)}`;
    const versionHref = (assignmentId: string, versionId: string) => `${assignmentPath(assignmentId)}/submissions/${encodeURIComponent(versionId)}?fromLearning=1`;
    const memberships = await tx.groupMember.findMany({
      where: { offeringId, courseMemberId: member.id },
      select: { id: true, joinedAt: true, leftAt: true, group: { select: { id: true, name: true } } },
      orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
    });
    const currentGroup = memberships.find(row => !row.leftAt)?.group ?? null;
    const assignments = await tx.assignment.findMany({
      where: { offeringId, status: { in: ['PUBLISHED', 'ARCHIVED', 'CANCELLED'] } },
      select: { id: true, title: true, status: true, mode: true, dueAt: true },
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { title: 'asc' }, { id: 'asc' }],
    });
    const assignmentsById = new Map(assignments.map(row => [row.id, row]));
    const versions = await tx.submissionVersion.findMany({
      where: studentSubmissionVersionVisibility(offeringId, member.id),
      select: { id: true, version: true, submittedAt: true, body: true,
        assignmentRevision: { select: { title: true, mode: true } },
        submission: { select: { id: true, assignmentId: true, courseMemberId: true, correctionUntil: true,
          group: { select: { id: true, name: true } } } },
        submittedBy: { select: { id: true, user: { select: { name: true } } } },
        participants: { select: { courseMember: { select: { id: true, user: { select: { name: true } } } } }, orderBy: { courseMemberId: 'asc' } },
        files: { select: { file: { select: { id: true, originalName: true, sizeBytes: true } } }, orderBy: { fileId: 'asc' } },
        reviews: { select: { id: true, body: true, createdAt: true, reviewer: { select: { id: true, user: { select: { name: true } } } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        reviewState: { select: { state: true } },
      },
      orderBy: [{ submittedAt: 'desc' }, { version: 'desc' }, { id: 'desc' }],
    });
    const participated = (row: typeof versions[number]) => row.submission.courseMemberId === member.id
      || row.participants.some(person => person.courseMember.id === member.id);
    const participatedResults: StudentLearningResult[] = [];
    const bySubmission = new Map<string, StudentLearningResult>();
    for (const row of versions) {
      if (!participated(row)) continue;
      const assignment = assignmentsById.get(row.submission.assignmentId)!;
      let result = bySubmission.get(row.submission.id);
      if (!result) {
        result = { submissionId: row.submission.id, assignmentId: assignment.id,
          title: row.assignmentRevision?.title ?? assignment.title, status: assignment.status,
          mode: row.assignmentRevision?.mode ?? assignment.mode, groupId: row.submission.group?.id ?? null,
          groupName: row.submission.group?.name ?? null, versions: [] };
        bySubmission.set(result.submissionId, result);
        participatedResults.push(result);
      }
      result.versions.push({ id: row.id, version: row.version, submittedAt: row.submittedAt, body: row.body,
        href: versionHref(assignment.id, row.id),
        submittedBy: { id: row.submittedBy.id, name: row.submittedBy.user.name },
        participants: row.participants.map(person => ({ id: person.courseMember.id, name: person.courseMember.user.name })),
        attachments: row.files.map(({ file }) => ({ id: file.id, name: file.originalName, size: Number(file.sizeBytes),
          href: `${assignmentPath(assignment.id)}/submissions/${encodeURIComponent(row.id)}/files/${encodeURIComponent(file.id)}` })),
        feedback: row.reviews.map(review => ({ id: review.id, body: review.body, createdAt: review.createdAt,
          author: { id: review.reviewer.id, name: review.reviewer.user.name } })),
      });
    }
    const now = new Date();
    // Submission confirmation and the assignment overview select the latest by version number.
    const latestByAssignment = new Map<string, typeof versions[number]>();
    for (const row of versions) {
      const assignment = assignmentsById.get(row.submission.assignmentId)!;
      const isCurrentOwner = assignment.mode === 'INDIVIDUAL' ? row.submission.courseMemberId === member.id
        : currentGroup !== null && row.submission.group?.id === currentGroup.id;
      if (!isCurrentOwner) continue;
      const latest = latestByAssignment.get(assignment.id);
      if (!latest || row.version > latest.version) latestByAssignment.set(assignment.id, row);
    }
    const currentAssignments: StudentLearningAssignment[] = assignments.filter(row => row.status === 'PUBLISHED').map(assignment => {
      const latest = latestByAssignment.get(assignment.id);
      const feedbackCount = latest?.reviews.length ?? 0;
      const correctionUntil = latest?.submission.correctionUntil && latest.submission.correctionUntil > now
        && assignment.dueAt && assignment.dueAt <= now ? latest.submission.correctionUntil : null;
      const blockedReason = member.offering.status === 'ARCHIVED' ? '本期课程已归档，仅可阅读已有记录。'
        : member.offering.status !== 'ACTIVE' ? '课程尚未开放提交。'
        : assignment.dueAt && assignment.dueAt <= now && !correctionUntil ? '已超过作业截止时间，不能继续提交。'
        : assignment.mode === 'GROUP' && !currentGroup ? '加入本期小组后可代表本组提交。' : null;
      const progress: AssignmentProgress = {
        state: assignment.mode === 'GROUP' && !currentGroup ? 'UNGROUPED' : !latest ? 'NOT_SUBMITTED'
          : feedbackCount ? 'FEEDBACK_AVAILABLE' : 'SUBMITTED',
        latestVersionId: latest?.id ?? null, feedbackCount,
        reviewState: latest ? latest.reviewState?.state ?? (feedbackCount > 0 ? 'LEGACY_UNKNOWN' : 'PENDING') : null,
      };
      return { id: assignment.id, title: assignment.title, mode: assignment.mode, dueAt: assignment.dueAt,
        progress, canSubmit: blockedReason === null, blockedReason,
        correctionUntil: member.offering.status === 'ACTIVE' ? correctionUntil : null,
        currentVersion: latest ? { id: latest.id,
          hasParticipated: participated(latest), submittedAt: latest.submittedAt,
          submittedByName: latest.submittedBy.user.name, groupName: latest.submission.group?.name ?? null } : null };
    });
    // These are deliberately the outward feedback tables, never private observations.
    const feedback = await tx.teachingFeedback.findMany({
      where: { offeringId, OR: [{ targetMemberId: member.id },
        { targetMemberId: null, recipients: { some: { memberId: member.id } } },
        ...(currentGroup ? [{ targetMemberId: null, targetGroupId: currentGroup.id }] : [])] },
      select: { id: true, targetMemberId: true, versionId: true, body: true, context: true, createdAt: true,
        author: { select: { id: true, name: true } }, targetGroup: { select: { id: true, name: true } },
        recipients: { where: { memberId: member.id }, select: { memberId: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const readableVersions = new Map(versions.map(row => [row.id, row]));
    const guidance: StudentLearningGuidance[] = feedback.map(row => {
      const version = row.versionId ? readableVersions.get(row.versionId) : undefined;
      const assignment = version ? assignmentsById.get(version.submission.assignmentId)! : null;
      return { id: row.id, href: `${base}/feedback#guidance-${encodeURIComponent(row.id)}`,
        body: row.body, context: row.context, createdAt: row.createdAt, author: row.author,
        groupId: row.targetGroup?.id ?? null, groupName: row.targetGroup?.name ?? null,
        recipientBasis: row.targetMemberId ? 'PERSONAL' : row.recipients.length ? 'RECEIVED_GROUP' : 'CURRENT_GROUP_SHARED',
        hasResultContext: !!row.versionId,
        result: version && assignment ? { id: version.id, assignmentId: assignment.id,
          title: version.assignmentRevision?.title ?? assignment.title, href: versionHref(assignment.id, version.id) } : null };
    });
    return { offering: member.offering, member: { id: member.id, name: member.user.name },
      currentGroup: currentGroup ? { ...currentGroup, href: `${base}/groups/${encodeURIComponent(currentGroup.id)}` } : null,
      currentAssignments, participatedResults, guidance,
      groupHistory: memberships.map(row => ({ id: row.id, groupId: row.group.id, groupName: row.group.name, joinedAt: row.joinedAt, leftAt: row.leftAt })) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
