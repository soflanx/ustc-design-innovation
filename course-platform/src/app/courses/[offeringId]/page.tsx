import Link from 'next/link';
import styles from '@/app/course-public.module.css';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { loginPath } from '@/lib/return-to';
import { canViewOffering, statusLabels, displayDate } from '@/lib/policy';
import { PageShell } from '@/components/site-shell';
import { CourseWorkspace } from '@/components/course-workspace';

export default async function OfferingPage({ params }: { params: Promise<{ offeringId: string }> }) {
  const { offeringId } = await params;
  const [offering, user] = await Promise.all([db.courseOffering.findUnique({ where: { id: offeringId }, include: { course: true, term: true } }), getCurrentUser()]);
  if (!offering) notFound();
  const membership = user ? await db.courseMember.findUnique({ where: { offeringId_userId: { offeringId, userId: user.id } } }) : null;
  const access = canViewOffering(user?.isAdmin ?? false, membership);
  if (offering.status === 'DRAFT' && !access) notFound();
  if (access && user) return <CourseWorkspace offering={offering} user={user} membership={membership}/>;
  const courseDescription = offering.course.description || offering.description;
  const termDescription = offering.description && offering.description !== courseDescription ? offering.description : null;
  const isArchived = offering.status === 'ARCHIVED';
  return <PageShell currentUser={user} context="public">
    <header className={styles.offeringHeading}><div className="container"><Link className={styles.offeringBack} href="/courses">← 课程目录</Link><h1>{offering.course.title}</h1><p>{offering.term.name}</p></div></header>
    <div className={`container ${styles.offeringBody}`}><div className={styles.offeringLayout}>
      <div>
        <section className={styles.offeringIntroduction}><h2>课程介绍</h2><p>{courseDescription || '课程介绍待补充。'}</p></section>
        {termDescription && <section className={styles.offeringNotes}><h2>{isArchived ? '该学期开课说明' : '本期开课说明'}</h2><p>{termDescription}</p></section>}
      </div>
      <aside className={styles.offeringSidebar} aria-label="开课信息">
        <h2>开课信息</h2><dl><div><dt>时间</dt><dd>{displayDate(offering.term.startDate)}<br/>至 {displayDate(offering.term.endDate)}</dd></div><div><dt>状态</dt><dd>{statusLabels[offering.status]}</dd></div></dl>
        {isArchived && <p className={styles.offeringArchive}>该学期已归档，内容保留供回顾。</p>}
        <Link className="button primary" href={loginPath(`/courses/${offeringId}`)}>{user ? '核对课程账号 →' : isArchived ? '该学期成员，登录查看 →' : '已加入课程，登录进入 →'}</Link>
        <p className="field-help">{user ? `当前账号尚未加入${isArchived ? '该学期' : '本期'}课程。请核对账号，或联系课程教师确认名单。` : isArchived ? '课程空间面向该学期成员，登录后可查看有权限的课程记录。' : '课程空间面向本期成员。选课与加入方式请以教学团队通知为准。'}</p>
      </aside>
    </div></div>
  </PageShell>;
}
