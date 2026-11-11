import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageShell } from '@/components/site-shell';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { getMyMemberships } from '@/lib/queries';
import { roleLabels, statusLabels } from '@/lib/policy';
import { courseLabel, offeringCourseTitle } from '@/lib/course-label';
import { canCreateCourse } from '@/lib/course-creation';
import styles from '@/app/learning-workspace.module.css';

export const dynamic = 'force-dynamic';

export default async function WorkspacePage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  const user = await requireUser(view === 'all' ? '/workspace?view=all' : '/workspace');
  const [memberships, canCreate] = await Promise.all([
    getMyMemberships(user.id),
    canCreateCourse(user.id),
  ]);
  const currentMemberships = memberships.filter(member => member.offering.status === 'ACTIVE');
  if (!user.isAdmin && view !== 'all' && currentMemberships.length === 1) redirect(`/courses/${currentMemberships[0].offeringId}`);
  const adminOfferings = user.isAdmin ? await db.courseOffering.findMany({ include: { course: true, term: true }, orderBy: { term: { startDate: 'desc' } } }) : [];
  const courses = user.isAdmin
    ? adminOfferings.map(offering => ({ offering, role: '管理员', audience: 'ADMIN' as const }))
    : memberships.map(member => ({ offering: member.offering, role: roleLabels[member.role], audience: member.role }));
  const current = courses.filter(({ offering }) => offering.status === 'ACTIVE');
  const drafts = courses.filter(({ offering }) => offering.status === 'DRAFT');
  const archived = courses.filter(({ offering }) => offering.status === 'ARCHIVED');

  const emptyMessage = canCreate ? '还没有发布课程。选择思维课或实践课，按当前学期直接发布。'
    : user.isDemo ? '当前演示账号暂无课程。可切换到已有课堂的演示账号。'
    : '当前账号暂无课程。请核对登录账号及教务系统中的课程信息。';

  function courseCards(items: Array<(typeof courses)[number]>) {
    return <div className={styles.courseGrid}>{items.map(({ offering, role }) => <article className={styles.courseCard} key={offering.id}>
      <Link className={styles.courseEntry} href={`/courses/${offering.id}`}>
        <div><h2>{courseLabel(offering.course, offering.term.name, offering.title)}</h2><p>{role} · {statusLabels[offering.status]}</p></div><span aria-hidden="true">→</span>
      </Link>
    </article>)}</div>;
  }

  return <PageShell currentUser={user} context="workspace"><div className={`container ${styles.page}`}>
    <header className={styles.selectionHeader}><h1>{user.isAdmin ? '全部课程' : '我的课程'}</h1>
      {canCreate && <Link className="button secondary" href="/manage/courses/new">发布课程</Link>}
    </header>
    {current.length ? courseCards(current) : courses.length ? <p className={styles.quietEmpty}>暂无正在进行的课程。</p> : <div className={styles.emptyPanel}><p>{emptyMessage}</p><div className="inline-actions"><Link href="/courses">浏览公开课程 →</Link><Link href="/login">核对或切换账号 →</Link></div></div>}
    {!!drafts.length && <section className={styles.draftSection}><h2>筹备中的课程</h2>{courseCards(drafts)}</section>}
    {!!archived.length && <details className={styles.archiveSection}><summary>往期课程 · {archived.length}</summary><div className={styles.archiveRows}>{archived.map(({ offering, role }) => <article className={styles.archiveRow} key={offering.id}><div><Link href={`/courses/${offering.id}`}>{offeringCourseTitle(offering)}</Link><p>{offering.term.name} · {role}</p></div><span>已归档</span></article>)}</div></details>}
  </div></PageShell>;
}
