import { Prisma } from '@prisma/client';
import { db } from './db';
import { DomainError } from './management';
import { getTeachingObservations } from './teaching-observations';

type HistorySubject = { memberId: string } | { groupId: string };

const nameSelect = { select: { name: true } } as const;
const groupSelect = { select: { id: true, name: true } } as const;
const assignmentSelect = { select: { id: true, title: true } } as const;
const guidanceSelect = {
  id: true, body: true, context: true, createdAt: true, author: nameSelect,
  targetGroup: groupSelect,
  version: { select: { id: true, assignmentRevision: { select: { title: true } }, submission: { select: { assignment: assignmentSelect } } } },
} satisfies Prisma.TeachingFeedbackSelect;

async function requireTeachingHistoryAccess(tx: Prisma.TransactionClient, userId: string, offeringId: string) {
  const staff = await tx.courseMember.findFirst({
    where: { offeringId, userId, status: 'ACTIVE', role: { in: ['TEACHER', 'TA'] } },
    select: { id: true },
  });
  if (!staff) throw new DomainError('只有本期教学团队可以查看学习记录。');
}

export const teachingMemberSearchLimit = 80;

export function teachingMemberSearch(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, teachingMemberSearchLimit) : '';
}

export async function listTeachingMembers(userId: string, offeringId: string, search = '') {
  return db.$transaction(async tx => {
    await requireTeachingHistoryAccess(tx, userId, offeringId);
    const members = await tx.courseMember.findMany({
      where: { offeringId, role: 'STUDENT' },
      select: {
        id: true, status: true, user: nameSelect,
        groupMemberships: { where: { leftAt: null }, take: 1, select: { group: groupSelect } },
      },
      orderBy: [{ status: 'asc' }, { user: { name: 'asc' } }, { id: 'asc' }],
    });
    const needle = teachingMemberSearch(search).normalize('NFKC').toLocaleLowerCase('zh-CN');
    return needle ? members.filter(member => member.user.name.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(needle)) : members;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

async function readTeachingHistory(userId: string, offeringId: string, subject: HistorySubject) {
  return db.$transaction(async tx => {
    await requireTeachingHistoryAccess(tx, userId, offeringId);
    const member = 'memberId' in subject ? await tx.courseMember.findFirst({
      where: { offeringId, id: subject.memberId, role: 'STUDENT' },
      select: {
        id: true, status: true, user: nameSelect,
        groupMemberships: {
          select: { id: true, group: groupSelect, joinedAt: true, leftAt: true },
          orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
        },
      },
    }) : null;
    const target = 'memberId' in subject ? member : await tx.group.findFirst({
      where: { offeringId, id: subject.groupId }, select: { id: true },
    });
    if (!target) throw new DomainError('本期没有这位学生或小组。');

    const results = await tx.submissionVersion.findMany({
      where: {
        offeringId, finalizedAt: { not: null },
        ...('memberId' in subject ? { OR: [
          { submission: { courseMemberId: subject.memberId } },
          { participants: { some: { courseMemberId: subject.memberId } } },
        ] } : { submission: { groupId: subject.groupId } }),
      },
      select: {
        id: true, version: true, submittedAt: true, submittedBy: { select: { user: nameSelect } },
        assignmentRevision: { select: { title: true } },
        submission: { select: { id: true, group: groupSelect, assignment: assignmentSelect } },
        reviews: {
          select: { id: true, body: true, createdAt: true, reviewer: { select: { user: nameSelect } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
      orderBy: [{ submittedAt: 'desc' }, { version: 'desc' }, { id: 'desc' }],
    });
    const receivedGroupGuidance = member ? await tx.teachingFeedback.findMany({
      where: {
        offeringId, targetGroupId: { not: null },
        recipients: { some: { offeringId, memberId: member.id } },
      },
      select: guidanceSelect,
    }) : [];
    return { member, results, receivedGroupGuidance };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function getTeachingHistory(userId: string, offeringId: string, subject: HistorySubject, options: { includeWithdrawn?: boolean } = {}) {
  const [{ member, results, receivedGroupGuidance }, notes] = await Promise.all([
    readTeachingHistory(userId, offeringId, subject),
    getTeachingObservations(userId, offeringId, subject, options),
  ]);
  const guidance = [...notes.feedback, ...receivedGroupGuidance]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  return { member, results, guidance, observations: notes.observations };
}

export type TeachingHistory = Awaited<ReturnType<typeof getTeachingHistory>>;

type Observation = TeachingHistory['observations'][number];
type SentFeedback = TeachingHistory['guidance'][number];
type Result = TeachingHistory['results'][number];
type DatedItem = { key: string; date: Date };
type ResultItem = DatedItem & { kind: 'result'; result: Result; notes: Observation[]; sent: SentFeedback[] };
type LessonItem = DatedItem & { kind: 'lesson'; page: NonNullable<Observation['page']>; notes: Observation[] };
type SubmissionOverview = { result: Result; earlier: Result[]; versionNotes: { version: Result; notes: Observation[] }[] };
type HistoryItem = ResultItem | LessonItem
  | DatedItem & { kind: 'note'; note: Observation }
  | DatedItem & { kind: 'sent'; feedback: SentFeedback };

/** Place each saved entry once, using stored relations rather than inferred course weeks. */
export function teachingHistoryItems({ results, observations, guidance }: Pick<TeachingHistory, 'results' | 'observations' | 'guidance'>): HistoryItem[] {
  const items: HistoryItem[] = [];
  const byVersion = new Map<string, ResultItem>();
  const byLesson = new Map<string, LessonItem>();
  for (const result of results) {
    const item: ResultItem = { kind: 'result', key: `result-${result.id}`, date: result.submittedAt, result, notes: [], sent: [] };
    byVersion.set(result.id, item);
    items.push(item);
  }
  for (const note of observations) {
    const version = note.version && byVersion.get(note.version.id);
    if (version) {
      version.notes.push(note);
      continue;
    }
    const date = note.observedAt ?? note.createdAt;
    if (!note.page) {
      items.push({ kind: 'note', key: `note-${note.id}`, date, note });
      continue;
    }
    const lesson = byLesson.get(note.page.id);
    if (lesson) {
      lesson.notes.push(note);
      if (date > lesson.date) lesson.date = date;
    } else {
      const item: LessonItem = { kind: 'lesson', key: `lesson-${note.page.id}`, date, page: note.page, notes: [note] };
      byLesson.set(note.page.id, item);
      items.push(item);
    }
  }
  for (const feedback of guidance) {
    const version = feedback.version && byVersion.get(feedback.version.id);
    if (version) version.sent.push(feedback);
    else items.push({ kind: 'sent', key: `sent-${feedback.id}`, date: feedback.createdAt, feedback });
  }
  return items.sort((a, b) => b.date.getTime() - a.date.getTime() || a.key.localeCompare(b.key));
}

export function teachingHistoryOverview({ results, observations }: Pick<TeachingHistory, 'results' | 'observations'>) {
  const lessons: LessonItem[] = [];
  const remarks: Observation[] = [];
  const unlinkedClassroomNotes: Observation[] = [];
  const notesByVersion = new Map<string, Observation[]>();
  // A recorded lesson takes precedence over a secondary link to a work version.
  const notes = teachingHistoryItems({ results: [], observations, guidance: [] });
  for (const item of notes) {
    if (item.kind === 'lesson') lessons.push(item);
    if (item.kind !== 'note') continue;
    const { note } = item;
    if (note.version) {
      const versionNotes = notesByVersion.get(note.version.id);
      if (versionNotes) versionNotes.push(note);
      else notesByVersion.set(note.version.id, [note]);
    } else if (note.kind === 'PARTICIPATION' || note.kind === 'LEAVE_REPORTED' || note.kind === 'LEAVE_CONFIRMED' || note.kind === 'ABSENT') {
      unlinkedClassroomNotes.push(note);
    } else {
      remarks.push(note);
    }
  }

  // Read results already arrive newest first, filtered to actual participation
  // for a member. Different groups may submit the same assignment separately.
  const submissions = new Map<string, SubmissionOverview>();
  for (const result of results) {
    const id = result.submission.id;
    const existing = submissions.get(id);
    const submission = existing ?? { result, earlier: [], versionNotes: [] };
    if (existing) existing.earlier.push(result);
    else submissions.set(id, submission);
    const versionNotes = notesByVersion.get(result.id);
    if (versionNotes) {
      submission.versionNotes.push({ version: result, notes: versionNotes });
      notesByVersion.delete(result.id);
    }
  }
  return {
    lessons, remarks, unlinkedClassroomNotes, submissions: [...submissions.values()],
    // A note with group context may relate to a student's own work, outside
    // the group's submissions. Keep the note without attributing work to the group.
    otherVersionNotes: [...notesByVersion.values()].flat(),
  };
}
