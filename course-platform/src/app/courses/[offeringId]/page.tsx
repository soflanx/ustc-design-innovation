import Link from 'next/link';
import styles from '@/app/course-public.module.css';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { loginPath } from '@/lib/return-to';
import { canManageOffering, canViewOffering, statusLabels, displayDate } from '@/lib/policy';
import { PageShell } from '@/components/site-shell';
import { CourseWorkspace } from '@/components/course-workspace';
import { offeringCourseTitle } from '@/lib/course-label';
import { getPublicOfferingNews } from '@/lib/queries';

export default async function OfferingPage({ params, searchParams }: {
  params: Promise<{ offeringId: string }>;
  searchParams: Promise<{ edit?: string; create?: string; view?: string }>;
}) {
  const { offeringId } = await params;
  const [offering, user] = await Promise.all([db.courseOffering.findUnique({ where: { id: offeringId }, include: { course: true, term: true } }), getCurrentUser()]);
  if (!offering) notFound();
  const membership = user ? await db.courseMember.findUnique({ where: { offeringId_userId: { offeringId, userId: user.id } } }) : null;
  const access = canViewOffering(user?.isAdmin ?? false, membership);
  if (offering.status === 'DRAFT' && !access) notFound();
  const { edit, create, view } = await searchParams;
  if (access && user && view !== 'public') {
    const initialIntent = create === 'assignment' ? 'create-assignment' : edit === '1' ? 'edit' : undefined;
    return <CourseWorkspace offering={offering} user={user} membership={membership} initialIntent={initialIntent}/>;
  }
  const reports = await getPublicOfferingNews(offeringId);
  const generalDescription = offering.course.description.trim();
  const offeringDescription = offering.description.trim();
  const courseDescription = generalDescription || offeringDescription;
  const termDescription = generalDescription && generalDescription !== offeringDescription ? offeringDescription : '';
  const isArchived = offering.status === 'ARCHIVED';
  const coursePath = `/courses/${encodeURIComponent(offeringId)}`;
  const courseLoginPath = loginPath(coursePath);
  return <PageShell currentUser={user} context="public">
    <header className={styles.offeringHeading}><div className="container"><Link className={styles.offeringBack} href="/courses">← 课程目录</Link><h1>{offeringCourseTitle(offering)}</h1><p>{offering.term.name}</p></div></header>
    <div className={`container ${styles.offeringBody}`}><div className={styles.offeringLayout}>
      <div>
        <section className={styles.offeringIntroduction}><h2>课程介绍</h2><p>{courseDescription || '课程介绍待补充。'}</p></section>
        {termDescription && <section className={styles.offeringNotes}><h2>{isArchived ? '该学期开课说明' : '本期开课说明'}</h2><p>{termDescription}</p></section>}
      </div>
      <aside className={styles.offeringSidebar} aria-label="开课信息">
        <h2>开课信息</h2><dl><div><dt>时间</dt><dd>{displayDate(offering.term.startDate)}<br/>至 {displayDate(offering.term.endDate)}</dd></div><div><dt>状态</dt><dd>{statusLabels[offering.status]}</dd></div></dl>
        {isArchived && <p className={styles.offeringArchive}>该学期已归档，内容保留供回顾。</p>}
        {offering.status === 'DRAFT' && <p className="field-help">本期正在筹备，开课后访客可见。</p>}
        {access && user && <div className="inline-actions">
          <Link className="button primary" href={coursePath}>{isArchived ? '查看课程记录 →' : '进入本期课堂 →'}</Link>
          {canManageOffering(user.isAdmin, membership) && <Link href={`${coursePath}/manage#public-introduction`}>返回课程管理</Link>}
        </div>}
        {user && !access && <>
          <p className="field-help">当前账号「{user.name}」未列入{isArchived ? '该学期' : '本期'}课程名单。{user.isDemo ? '可切换演示账号查看对应课堂。' : '请核对登录账号及教务系统中的课程信息。'}</p>
          <div className="inline-actions">
            <Link className="button primary" href="/workspace?view=all">查看我的课程 →</Link>
            <Link href={courseLoginPath}>切换账号</Link>
          </div>
        </>}
        {!user && <>
          <Link className="button primary" href={courseLoginPath}>{isArchived ? '该学期成员，登录查看 →' : '本期师生，登录进入 →'}</Link>
          <p className="field-help">{isArchived ? '课程空间面向该学期成员，登录后可查看有权限的课程记录。' : '学生选课请在学校教务系统办理。'}</p>
        </>}
      </aside>
    </div>
      {!!reports.length && <section id="course-reports" className={styles.offeringReports} aria-labelledby="course-reports-title">
        <h2 id="course-reports-title">{isArchived ? '该学期课程报道' : '本期课程报道'}</h2>
        <ul>{reports.map(report => <li key={report.slug}>
          <Link href={{ pathname: `/news/${encodeURIComponent(report.slug)}`, query: { from: offeringId } }}>
            <span className={styles.reportTitle}>{report.title}</span>
            {report.publishedAt && <time dateTime={report.publishedAt.toISOString()}>发布于 {displayDate(report.publishedAt)}</time>}
          </Link>
        </li>)}</ul>
      </section>}
    </div>
  </PageShell>;
}
