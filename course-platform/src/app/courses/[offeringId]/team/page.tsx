import { requireOfferingAccess } from '@/lib/access';
import { db } from '@/lib/db';
import { roleLabels } from '@/lib/policy';
import { CourseFrame } from '@/components/course-frame';
import styles from '@/components/course-frame.module.css';

export default async function TeamPage({ params }: { params: Promise<{ offeringId: string }> }) {
  const { offeringId } = await params;
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, `/courses/${offeringId}/team`);
  const team = await db.courseMember.findMany({ where: { offeringId, status: 'ACTIVE', role: { in: ['TEACHER', 'TA'] } }, include: { user: true }, orderBy: { role: 'desc' } });
  return <CourseFrame user={user} offering={offering} membership={membership} active="team">
    <header className="page-heading"><h1>教学团队</h1></header>
    {team.length ? <div className={styles.teamList}>{team.map(member => <article className={styles.teamRow} key={member.id}>
      <p>{roleLabels[member.role]}</p><div><h2>{member.user.name}</h2><a href={`mailto:${member.user.email}`}>{member.user.email}</a></div>
    </article>)}</div> : <p className="empty-state">教学团队信息待补充。</p>}
  </CourseFrame>;
}
