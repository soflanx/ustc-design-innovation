import type { Prisma } from '@prisma/client';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import styles from '@/app/group-space.module.css';
import { requireOfferingAccess } from '@/lib/access';
import { db } from '@/lib/db';
import { CourseFrame } from '@/components/course-frame';
import { GroupFormationSettings, StudentGroupFormation } from '@/components/group-formation';
import { getGroupFormationWindow, listRecruitingGroups } from '@/lib/group-formation';
import { getGroupActivitySource } from '@/lib/course-subpages';
import { showcaseReviewStatus, showcaseWorkspaceHref } from '@/lib/group-showcase-contract';
import { courseLessonHref, groupWorkHref, parseGroupSource, parseLessonRecordOrigin, setLessonRecordOrigin, type LessonRecordOriginQuery } from '@/lib/group-work-link';
import { canManageOffering, isActiveTeachingMember } from '@/lib/policy';

function selectedActivityIds(selections: Prisma.JsonValue | undefined) {
  if (!Array.isArray(selections)) return [];
  return selections.flatMap(selection => {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return [];
    if (selection.source !== 'ACTIVITY' || typeof selection.sourceId !== 'string') return [];
    return [selection.sourceId];
  });
}

export default async function GroupsPage({ params, searchParams }: {
  params: Promise<{ offeringId: string }>;
  searchParams: Promise<LessonRecordOriginQuery & { fromPage?: unknown }>;
}) {
  const { offeringId } = await params;
  const query = await searchParams;
  const requestedPage = parseGroupSource(query.fromPage);
  const requestedRecords = parseLessonRecordOrigin(query);
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, groupWorkHref(offeringId, requestedPage, undefined, requestedRecords));
  const source = await getGroupActivitySource(user, offeringId, requestedPage, membership?.role);
  const staff = user.isAdmin || membership?.role === 'TEACHER' || membership?.role === 'TA';
  const teachingTeam = isActiveTeachingMember(membership);
  const lessonRecords = source && teachingTeam ? requestedRecords : undefined;
  const archived = offering.status === 'ARCHIVED';
  const formation = getGroupFormationWindow(offering);
  const canManageGrouping = canManageOffering(user.isAdmin, membership);
  if (!staff) {
    const ownGroup = await db.groupMember.findFirst({
      where: { offeringId, courseMemberId: membership!.id, leftAt: null }, select: { groupId: true },
    });
    if (ownGroup) redirect(groupWorkHref(offeringId, source?.id, ownGroup.groupId));
  }
  const recruiting = !staff && formation ? await listRecruitingGroups(user.id, offeringId) : [];
  const groups = staff ? await db.group.findMany({
    where: { offeringId }, orderBy: { name: 'asc' },
    select: {
      id: true, name: true, description: true, page: { select: { title: true, body: true } },
      members: {
        where: { leftAt: null, courseMember: { status: 'ACTIVE' } },
        select: { courseMember: { select: { user: { select: { name: true } } } } },
      },
      taAssignments: {
        where: { endedAt: null, courseMember: { status: 'ACTIVE' } },
        select: { courseMemberId: true, courseMember: { select: { user: { select: { name: true } } } } },
      },
      showcaseDraft: teachingTeam ? { select: { revision: true, title: true, body: true, selections: true } } : false,
      showcasePublications: teachingTeam ? {
        where: { supersededAt: null }, distinct: ['scope'], orderBy: [{ scope: 'asc' }, { sequence: 'desc' }],
        select: { scope: true, draftRevision: true, withdrawnAt: true },
      } : false,
    },
  }) : [];
  const selectedActivities = groups.flatMap(group => selectedActivityIds(group.showcaseDraft?.selections)
    .map(activityId => ({ activityId, groupId: group.id })));
  const [availableActivities, ungrouped] = await Promise.all([
    selectedActivities.length ? db.groupActivity.findMany({
      where: { offeringId, withdrawnAt: null, id: { in: [...new Set(selectedActivities.map(item => item.activityId))] } },
      select: { id: true, groupId: true },
    }) : [],
    teachingTeam ? db.courseMember.findMany({
      where: { offeringId, status: 'ACTIVE', role: 'STUDENT', groupMemberships: { none: { offeringId, leftAt: null } } },
      select: { id: true, user: { select: { name: true } } }, orderBy: [{ user: { name: 'asc' } }, { id: 'asc' }],
    }) : [],
  ]);
  const activityGroupById = new Map(availableActivities.map(activity => [activity.id, activity.groupId]));
  const groupsWithUnavailableActivities = new Set(selectedActivities
    .filter(({ activityId, groupId }) => activityGroupById.get(activityId) !== groupId)
    .map(({ groupId }) => groupId));
  const memberSource = new URLSearchParams(source ? { fromPage: source.id } : undefined);
  setLessonRecordOrigin(memberSource, lessonRecords);
  const showcaseOrigin = new URLSearchParams(memberSource);
  showcaseOrigin.set('fromGroups', '1');
  const isTa = !user.isAdmin && membership?.role === 'TA';
  const assigned = isTa ? groups.filter(group => group.taAssignments.some(a => a.courseMemberId === membership.id)) : [];
  const otherGroups = isTa ? groups.filter(group => !assigned.some(item => item.id === group.id)) : [];
  const canArrange = canManageGrouping && !archived && !formation && Boolean(offering.groupFormationClosesAt) && groups.length > 0;
  function groupCard(group: (typeof groups)[number]) {
    const projectTitle = group.page?.title || group.name;
    const description = group.page?.body || group.description;
    const draft = teachingTeam ? group.showcaseDraft : null;
    const reviewStatus = draft ? showcaseReviewStatus(draft, group.showcasePublications, offering.status === 'ACTIVE', {
      hasUnavailableActivity: groupsWithUnavailableActivities.has(group.id),
    }) : undefined;
    return <article className={styles.groupCard} key={group.id}>
      {projectTitle !== group.name && <div className={styles.groupIdentity}>{group.name}</div>}
      <h3><Link href={groupWorkHref(offeringId, source?.id, group.id, lessonRecords)}>{projectTitle}</Link></h3>
      {draft && <p className={styles.groupShowcase}>
        <Link href={showcaseWorkspaceHref(offeringId, group.id, showcaseOrigin, true)} prefetch={false}
          aria-label={`已有展示稿，查看${group.name}的预览`}>已有展示稿 →</Link>
        {reviewStatus && <span>{reviewStatus}</span>}
      </p>}
      {description && <p className={styles.preview}>{description}</p>}
      <div className={styles.cardTeam}>
        <p><span>组员</span>{group.members.map(m => m.courseMember.user.name).join('、') || '待分配'}</p>
        <p><span>助教</span>{group.taAssignments.map(a => a.courseMember.user.name).join('、') || '待分配'}</p>
      </div>
    </article>;
  }
  return <CourseFrame user={user} offering={offering} membership={membership} active="groups" groupSourcePageId={source?.id} groupSourceLessonRecords={lessonRecords}><div className={styles.space}>
    <header className={styles.heading}>
      {source && <Link className="breadcrumb" href={courseLessonHref(offeringId, source.id, lessonRecords)}>← 返回《{source.title}》{lessonRecords && '记录'}</Link>}
      <h1>{staff ? '小组' : '我的小组'}</h1>
    </header>
    {archived && <p className={styles.archive}>本学期已归档，小组主页保持只读。</p>}
    {canManageGrouping && <GroupFormationSettings offeringId={offeringId} expectedUserId={user.id} window={formation}
      capacity={offering.groupFormationCapacity} closesAt={offering.groupFormationClosesAt} archived={archived}/>}
    {!staff && (formation ? <StudentGroupFormation offeringId={offeringId} expectedUserId={user.id} sourcePageId={source?.id} window={formation} groups={recruiting}/>
      : <div className="empty-state">
        <p>{archived ? '本学期没有你的分组记录。' : `你尚未分组，${offering.groupFormationWindowId ? '本期自助组队已结束。' : '本期尚未开放自助组队。'}`}</p>
        {!archived && <p><Link href={`/courses/${encodeURIComponent(offeringId)}/team`}>联系课程教师 →</Link></p>}
      </div>)}
    {staff && (isTa ? <>
      <section className={styles.groupSection}><h2>我负责的小组</h2>{assigned.length ? <div className={styles.groupGrid}>{assigned.map(groupCard)}</div> : <p className={styles.empty}>{archived ? '本学期没有你的负责小组记录。' : '当前未分配负责小组。'}</p>}</section>
      {!!otherGroups.length && <details className={styles.otherGroups}><summary>其他小组</summary><div className={styles.groupGrid}>{otherGroups.map(groupCard)}</div></details>}
    </> : <section className={styles.groupSection}>{groups.length ? <div className={styles.groupGrid}>{groups.map(groupCard)}</div> : <div className="empty-state">{archived ? '本学期没有小组记录。' : '本学期尚未创建小组。'}</div>}</section>)}
    {ungrouped.length > 0 && <section className={styles.groupSection}>
      <h2>未分组学生</h2>
      <ul className={styles.ungroupedList}>{ungrouped.map(member => <li key={member.id}>
        <Link href={`/courses/${encodeURIComponent(offeringId)}/members/${encodeURIComponent(member.id)}${memberSource.size ? `?${memberSource}` : ''}`}>{member.user.name}</Link>
        {canArrange && <Link href={`/courses/${encodeURIComponent(offeringId)}/manage?${new URLSearchParams({ arrangeStudent: member.id })}#group-arrangement`}
          aria-label={`为${member.user.name}安排小组`}>安排小组 →</Link>}
      </li>)}</ul>
    </section>}
  </div></CourseFrame>;
}
