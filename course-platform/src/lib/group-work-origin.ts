import { getGroupActivitySource } from './course-subpages';
import { db } from './db';
import { courseLessonHref, parseGroupSource, parseLessonRecordOrigin, setLessonRecordOrigin, type LessonRecordOriginQuery } from './group-work-link';
import { isActiveTeachingMember, type Membership } from './policy';
import { teachingMemberSearch } from './teaching-history';

export type GroupWorkOriginQuery = LessonRecordOriginQuery & {
  fromPage?: unknown;
  fromMember?: unknown;
  fromGroup?: unknown;
  fromRecords?: unknown;
  fromRecordsMember?: unknown;
  fromMemberSearch?: unknown;
  fromMemberWithdrawn?: unknown;
};

export function groupWorkOriginParams(query: GroupWorkOriginQuery) {
  const params = new URLSearchParams();
  const pageId = parseGroupSource(query.fromPage);
  if (pageId) {
    params.set('fromPage', pageId);
    setLessonRecordOrigin(params, parseLessonRecordOrigin(query));
  }
  const memberId = parseGroupSource(query.fromMember);
  if (memberId) {
    params.set('fromMember', memberId);
    const priorGroup = parseGroupSource(query.fromGroup);
    if (priorGroup) params.set('fromGroup', priorGroup);
    if (query.fromRecords === '1') {
      params.set('fromRecords', '1');
      if (query.fromRecordsMember === '1') params.set('fromRecordsMember', '1');
    }
    const search = teachingMemberSearch(query.fromMemberSearch);
    if (search) params.set('fromMemberSearch', search);
    if (query.fromMemberWithdrawn === '1') params.set('fromMemberWithdrawn', '1');
  }
  return params;
}

export async function getGroupWorkOrigin(
  user: { id: string; isAdmin: boolean }, membership: Membership, offeringId: string, groupId: string, requested: URLSearchParams,
) {
  const teachingTeam = isActiveTeachingMember(membership);
  const memberId = requested.get('fromMember');
  const priorGroupId = requested.get('fromGroup');
  const [source, member] = await Promise.all([
    getGroupActivitySource(user, offeringId, requested.get('fromPage') ?? undefined, membership?.role),
    teachingTeam && memberId ? db.courseMember.findFirst({
      where: {
        id: memberId, offeringId, role: 'STUDENT', groupMemberships: { some: { offeringId, groupId } },
      },
      select: {
        id: true, user: { select: { name: true } },
        groupMemberships: {
          where: { offeringId, groupId: priorGroupId ?? groupId }, take: 1, select: { groupId: true },
        },
      },
    }) : null,
  ]);
  const lessonRecords = source && teachingTeam ? parseLessonRecordOrigin({
    fromLessonRecords: requested.get('fromLessonRecords'), fromLessonRecordsWithdrawn: requested.get('fromLessonRecordsWithdrawn'),
  }) : undefined;
  const lessonReturn = source && {
    href: courseLessonHref(offeringId, source.id, lessonRecords),
    label: `返回《${source.title}》${lessonRecords ? '记录' : ''}`,
  };
  const params = groupWorkOriginParams({
    fromPage: source?.id, fromLessonRecords: lessonRecords ? '1' : undefined,
    fromLessonRecordsWithdrawn: lessonRecords?.includeWithdrawn ? '1' : undefined,
    fromMember: member?.id, fromGroup: member?.groupMemberships[0]?.groupId === priorGroupId ? priorGroupId : undefined,
    fromRecords: requested.get('fromRecords'), fromRecordsMember: requested.get('fromRecordsMember'),
    fromMemberSearch: requested.get('fromMemberSearch'), fromMemberWithdrawn: requested.get('fromMemberWithdrawn'),
  });
  // The member page uses its own search and history parameters.
  if (!member) return { source, lessonRecords, lessonReturn, memberReturn: null, params };
  const query = new URLSearchParams(params);
  query.delete('fromMember');
  const search = query.get('fromMemberSearch');
  query.delete('fromMemberSearch');
  if (search) query.set('q', search);
  const includeWithdrawn = query.get('fromMemberWithdrawn');
  query.delete('fromMemberWithdrawn');
  if (includeWithdrawn) query.set('includeWithdrawn', '1');
  const path = `/courses/${encodeURIComponent(offeringId)}/members/${encodeURIComponent(member.id)}`;
  const memberReturn = { id: member.id, href: `${path}${query.size ? `?${query}` : ''}`, label: `返回${member.user.name}` };
  return { source, lessonRecords, lessonReturn, memberReturn, params };
}
