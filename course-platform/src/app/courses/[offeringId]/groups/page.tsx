import Link from 'next/link';
import { redirect } from 'next/navigation';
import styles from '@/app/group-space.module.css';
import { requireOfferingAccess } from '@/lib/access';
import { db } from '@/lib/db';
import { CourseFrame } from '@/components/course-frame';

export default async function GroupsPage({ params }: { params: Promise<{ offeringId: string }> }) {
  const { offeringId } = await params;
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, `/courses/${offeringId}/groups`);
  const staff = user.isAdmin || membership?.role === 'TEACHER' || membership?.role === 'TA';
  const groups = await db.group.findMany({ where: { offeringId, ...(staff ? {} : { members: { some: { courseMemberId: membership!.id, leftAt: null } } }) }, orderBy: { name: 'asc' }, include: { page: true, members: { where: { leftAt: null, courseMember: { status: 'ACTIVE' } }, include: { courseMember: { include: { user: true } } } }, taAssignments: { where: { endedAt: null, courseMember: { status: 'ACTIVE' } }, include: { courseMember: { include: { user: true } } } } } });
  if (!staff && groups.length === 1) redirect(`/courses/${offeringId}/groups/${groups[0].id}`);
  const isTa = !user.isAdmin && membership?.role === 'TA';
  const assigned = !user.isAdmin && membership?.role === 'TA' ? groups.filter(group => group.taAssignments.some(a => a.courseMemberId === membership.id)) : [];
  const otherGroups = isTa ? groups.filter(group => !assigned.some(item => item.id === group.id)) : [];
  function groupCard(group: (typeof groups)[number]) {
    return <article className={styles.groupCard} key={group.id}>{group.page?.title && group.page.title !== group.name && <div className={styles.groupIdentity}>{group.name}</div>}<h3><Link href={`/courses/${offeringId}/groups/${group.id}`}>{group.page?.title && group.page.title !== group.name ? group.page.title : group.name}</Link></h3>{(group.page?.body || group.description) && <p className={styles.preview}>{group.page?.body || group.description}</p>}<div className={styles.cardTeam}><p><span>组员</span>{group.members.map(m => m.courseMember.user.name).join('、') || '待分配'}</p><p><span>助教</span>{group.taAssignments.map(a => a.courseMember.user.name).join('、') || '待分配'}</p></div></article>;
  }
  return <CourseFrame user={user} offering={offering} membership={membership} active="groups"><div className={styles.space}>
    <header className={styles.heading}><h1>{staff ? '小组' : '我的小组'}</h1></header>
    {offering.status === 'ARCHIVED' && <p className={styles.archive}>本学期已归档，小组主页保持只读。</p>}
    {isTa ? <>
      <section className={styles.groupSection}><h2>我负责的小组</h2>{assigned.length ? <div className={styles.groupGrid}>{assigned.map(groupCard)}</div> : <p className={styles.empty}>{offering.status === 'ARCHIVED' ? '本学期没有你的负责小组记录。' : '当前未分配负责小组。'}</p>}</section>
      {!!otherGroups.length && <details className={styles.otherGroups}><summary>其他小组</summary><div className={styles.groupGrid}>{otherGroups.map(groupCard)}</div></details>}
    </> : <section className={styles.groupSection}>{groups.length ? <div className={styles.groupGrid}>{groups.map(groupCard)}</div> : <div className="empty-state">{offering.status === 'ARCHIVED' ? (staff ? '本学期没有小组记录。' : '本学期没有你的分组记录。') : (staff ? '本学期尚未创建小组。' : '你尚未分配到小组，请联系课程教师。')}{!staff && <p><Link href={`/courses/${offeringId}/team`}>查看教学团队 →</Link></p>}</div>}</section>}
  </div></CourseFrame>;
}
