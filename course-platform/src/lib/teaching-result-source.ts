import type { Prisma } from '@prisma/client';
import { db } from './db';
import { getGroupActivitySource } from './course-subpages';
import { courseLessonHref, groupWorkHref, parseGroupSource } from './group-work-link';
import { teachingMemberSearch } from './teaching-history';

export type TeachingResultSourceQuery = {
  fromMember?: unknown;
  fromGroup?: unknown;
  fromPage?: unknown;
  fromRecords?: unknown;
  fromRecordsMember?: unknown;
  fromLessonRecords?: unknown;
  fromMemberSearch?: unknown;
  fromGroupMember?: unknown;
  fromGroupMemberPriorGroup?: unknown;
};

export function parseTeachingResultSource(query: TeachingResultSourceQuery) {
  const fromMember = parseGroupSource(query.fromMember);
  const fromGroup = parseGroupSource(query.fromGroup);
  const fromPage = parseGroupSource(query.fromPage);
  if ((!fromMember && !fromGroup && !fromPage) || (query.fromMember !== undefined && !fromMember)
    || (query.fromGroup !== undefined && !fromGroup) || (query.fromPage !== undefined && !fromPage)) return null;
  const fromGroupMember = fromGroup && !fromMember ? parseGroupSource(query.fromGroupMember) : undefined;
  const fromGroupMemberPriorGroup = fromGroupMember ? parseGroupSource(query.fromGroupMemberPriorGroup) : undefined;
  const memberOrigin = fromMember || fromGroupMember;
  const fromRecords = memberOrigin && query.fromRecords === '1' ? query.fromRecords : undefined;
  const fromRecordsMember = fromRecords && query.fromRecordsMember === '1' ? query.fromRecordsMember : undefined;
  const fromLessonRecords = fromPage && query.fromLessonRecords === '1' ? query.fromLessonRecords : undefined;
  const fromMemberSearch = memberOrigin ? teachingMemberSearch(query.fromMemberSearch) || undefined : undefined;
  return { fromMember, fromGroup, fromPage, fromRecords, fromRecordsMember, fromLessonRecords, fromMemberSearch, fromGroupMember, fromGroupMemberPriorGroup };
}

export function teachingResultSourceParams(source: NonNullable<ReturnType<typeof parseTeachingResultSource>>) {
  const params = new URLSearchParams();
  if (source.fromMember) params.set('fromMember', source.fromMember);
  if (source.fromGroup) params.set('fromGroup', source.fromGroup);
  if (source.fromPage) params.set('fromPage', source.fromPage);
  const memberOrigin = source.fromMember || source.fromGroupMember;
  if (memberOrigin && source.fromRecords) {
    params.set('fromRecords', source.fromRecords);
    if (source.fromRecordsMember) params.set('fromRecordsMember', source.fromRecordsMember);
  }
  if (source.fromPage && source.fromLessonRecords) params.set('fromLessonRecords', source.fromLessonRecords);
  if (memberOrigin && source.fromMemberSearch) params.set('fromMemberSearch', source.fromMemberSearch);
  if (source.fromGroup && source.fromGroupMember) {
    params.set('fromGroupMember', source.fromGroupMember);
    if (source.fromGroupMemberPriorGroup) params.set('fromGroupMemberPriorGroup', source.fromGroupMemberPriorGroup);
  }
  return params;
}

async function resolveTeachingSource(userId: string, offeringId: string, query: TeachingResultSourceQuery) {
  const source = parseTeachingResultSource(query);
  if (!source) return null;
  const actor = await db.courseMember.findFirst({
    where: { offeringId, userId, status: 'ACTIVE', role: { in: ['TEACHER', 'TA'] } },
    select: { role: true },
  });
  if (!actor) return null;

  const { fromMember, fromGroup } = source;
  const member = fromMember ? await db.courseMember.findFirst({
    where: { id: fromMember, offeringId, role: 'STUDENT' },
    select: { user: { select: { name: true } } },
  }) : null;
  if (fromMember && !member) return null;
  const group = fromGroup ? await db.group.findFirst({ where: { id: fromGroup, offeringId }, select: { name: true } }) : null;
  if (fromGroup && !group) return null;
  if (fromMember && fromGroup && !await db.groupMember.findFirst({
    where: { offeringId, courseMemberId: fromMember, groupId: fromGroup },
    select: { groupId: true },
  })) return null;
  const groupMember = fromGroup && source.fromGroupMember ? await db.courseMember.findFirst({
    where: {
      id: source.fromGroupMember, offeringId, role: 'STUDENT',
      groupMemberships: { some: { offeringId, groupId: fromGroup } },
    },
    select: {
      id: true,
      groupMemberships: {
        where: { offeringId, groupId: source.fromGroupMemberPriorGroup }, take: 1, select: { groupId: true },
      },
    },
  }) : null;
  const priorGroup = groupMember?.groupMemberships[0]?.groupId === source.fromGroupMemberPriorGroup
    ? source.fromGroupMemberPriorGroup : undefined;
  const page = await getGroupActivitySource({ id: userId, isAdmin: false }, offeringId, source.fromPage, actor.role);
  const params = teachingResultSourceParams({
    ...source, fromPage: page?.id, fromGroupMember: groupMember?.id, fromGroupMemberPriorGroup: priorGroup,
  });
  if (!fromMember && !fromGroup && page) return {
    href: courseLessonHref(offeringId, page.id, !!source.fromLessonRecords),
    name: `《${page.title}》`, params, fromMember, fromGroup,
  };
  const back = new URLSearchParams(params);
  if (fromMember && member) {
    back.delete('fromMember');
    back.delete('fromMemberSearch');
    if (source.fromMemberSearch) back.set('q', source.fromMemberSearch);
    const path = `/courses/${encodeURIComponent(offeringId)}/members/${encodeURIComponent(fromMember)}`;
    return { href: `${path}${back.size ? `?${back}` : ''}`, name: member.user.name, params, fromMember, fromGroup };
  }
  if (!fromGroup || !group) return null;
  back.delete('fromGroup');
  back.delete('fromGroupMember');
  back.delete('fromGroupMemberPriorGroup');
  if (groupMember) {
    back.set('fromMember', groupMember.id);
    if (priorGroup) back.set('fromGroup', priorGroup);
  }
  const path = groupWorkHref(offeringId, undefined, fromGroup);
  return { href: `${path}${back.size ? `?${back}` : ''}`, name: group.name, params, fromMember, fromGroup };
}

export async function getTeachingLessonReturn(userId: string, offeringId: string, query: TeachingResultSourceQuery) {
  const source = await resolveTeachingSource(userId, offeringId, query);
  return source && (source.fromMember || source.fromGroup)
    ? { href: source.href, label: `返回${source.name}`, params: source.params } : null;
}

export async function getTeachingResultSource(
  userId: string, offeringId: string, assignmentId: string, query: TeachingResultSourceQuery, versionId?: string, fromVersion?: string,
) {
  const source = await resolveTeachingSource(userId, offeringId, query);
  if (!source) return null;
  const { fromMember, fromGroup } = source;
  const back = { href: source.href, name: source.name, params: source.params };
  if (!fromMember && !fromGroup) return { ...back, sourceVersionId: undefined };
  const versionScope = { offeringId, finalizedAt: { not: null } };
  const relations: Prisma.SubmissionVersionWhereInput[] = fromMember ? [
    { submission: { courseMemberId: fromMember } },
    { participants: { some: { courseMemberId: fromMember } } },
    { feedback: { some: { OR: [{ targetMemberId: fromMember }, { recipients: { some: { memberId: fromMember } } }] } } },
  ] : [
    { submission: { groupId: fromGroup } },
    { observations: { some: { contextGroupId: fromGroup, revisions: { none: { action: 'WITHDRAWN' } } } } },
  ];
  // A version switch can keep the source of an earlier version in this submission.
  const sourceVersionId = versionId ? parseGroupSource(fromVersion) : undefined;
  const result = await db.submissionVersion.findFirst({
    where: {
      id: versionId, ...versionScope,
      submission: {
        offeringId, assignmentId,
        ...(sourceVersionId ? { versions: { some: { id: sourceVersionId, ...versionScope, OR: relations } } } : {}),
      },
      ...(sourceVersionId ? {} : { OR: relations }),
    },
    select: { id: true },
  });
  if (!result) return null;
  return { ...back, sourceVersionId: sourceVersionId ?? versionId };
}
