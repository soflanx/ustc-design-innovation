import Link from 'next/link';
import { redirect } from 'next/navigation';
import styles from '@/app/group-space.module.css';
import { requireOfferingAccess } from '@/lib/access';
import { db } from '@/lib/db';
import { CourseFrame } from '@/components/course-frame';
import { GroupFormationSettings, StudentGroupFormation } from '@/components/group-formation';
import { getGroupFormationWindow, listRecruitingGroups } from '@/lib/group-formation';
import { getGroupActivitySource } from '@/lib/course-subpages';
import { groupWorkHref, parseGroupSource } from '@/lib/group-work-link';
import { canManageOffering } from '@/lib/policy';

export default async function GroupsPage({ params, searchParams }: {
  params: Promise<{ offeringId: string }>;
  searchParams: Promise<{ fromPage?: string | string[] }>;
}) {
  const { offeringId } = await params;
  const requestedPage = parseGroupSource((await searchParams).fromPage);
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, groupWorkHref(offeringId, requestedPage));
  const source = await getGroupActivitySource(user, offeringId, requestedPage, membership?.role);
  const staff = user.isAdmin || membership?.role === 'TEACHER' || membership?.role === 'TA';
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
  const groups = staff ? await db.group.findMany({ where: { offeringId }, orderBy: { name: 'asc' }, include: { page: true, members: { where: { leftAt: null, courseMember: { status: 'ACTIVE' } }, include: { courseMember: { include: { user: true } } } }, taAssignments: { where: { endedAt: null, courseMember: { status: 'ACTIVE' } }, include: { courseMember: { include: { user: true } } } } } }) : [];
  const teachingTeam = membership?.status === 'ACTIVE' && (membership.role === 'TEACHER' || membership.role === 'TA');
  const ungrouped = teachingTeam ? await db.courseMember.findMany({
    where: { offeringId, status: 'ACTIVE', role: 'STUDENT', groupMemberships: { none: { offeringId, leftAt: null } } },
    select: { id: true, user: { select: { name: true } } }, orderBy: [{ user: { name: 'asc' } }, { id: 'asc' }],
  }) : [];
  const memberSource = source ? `?${new URLSearchParams({ fromPage: source.id })}` : '';
  const isTa = !user.isAdmin && membership?.role === 'TA';
  const assigned = !user.isAdmin && membership?.role === 'TA' ? groups.filter(group => group.taAssignments.some(a => a.courseMemberId === membership.id)) : [];
  const otherGroups = isTa ? groups.filter(group => !assigned.some(item => item.id === group.id)) : [];
  const canArrange = canManageGrouping && !archived && !formation && Boolean(offering.groupFormationClosesAt) && groups.length > 0;
  function groupCard(group: (typeof groups)[number]) {
    return <article className={styles.groupCard} key={group.id}>{group.page?.title && group.page.title !== group.name && <div className={styles.groupIdentity}>{group.name}</div>}<h3><Link href={groupWorkHref(offeringId, source?.id, group.id)}>{group.page?.title && group.page.title !== group.name ? group.page.title : group.name}</Link></h3>{(group.page?.body || group.description) && <p className={styles.preview}>{group.page?.body || group.description}</p>}<div className={styles.cardTeam}><p><span>组员</span>{group.members.map(m => m.courseMember.user.name).join('、') || '待分配'}</p><p><span>助教</span>{group.taAssignments.map(a => a.courseMember.user.name).join('、') || '待分配'}</p></div></article>;
  }
  return <CourseFrame user={user} offering={offering} membership={membership} active="groups" groupSourcePageId={source?.id}><div className={styles.space}>
    <header className={styles.heading}>
      {source && <Link className="breadcrumb" href={`/courses/${encodeURIComponent(offeringId)}/pages/${encodeURIComponent(source.id)}`}>← 返回《{source.title}》</Link>}
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
        <Link href={`/courses/${encodeURIComponent(offeringId)}/members/${encodeURIComponent(member.id)}${memberSource}`}>{member.user.name}</Link>
        {canArrange && <Link href={`/courses/${encodeURIComponent(offeringId)}/manage?${new URLSearchParams({ arrangeStudent: member.id })}#group-arrangement`}
          aria-label={`为${member.user.name}安排小组`}>安排小组 →</Link>}
      </li>)}</ul>
    </section>}
  </div></CourseFrame>;
}
