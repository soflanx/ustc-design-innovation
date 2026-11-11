import Link from 'next/link';
import styles from '@/app/course-public.module.css';
import { PageShell } from '@/components/site-shell';
import { getCurrentUser } from '@/lib/auth';
import { getPublicCourses, getMyMemberships } from '@/lib/queries';
import { displayDate } from '@/lib/policy';
import { offeringCourseTitle } from '@/lib/course-label';

export const dynamic = 'force-dynamic';

export default async function CoursesPage() {
  const [courses, user] = await Promise.all([getPublicCourses(), getCurrentUser()]);
  const memberships = user && !user.isAdmin ? await getMyMemberships(user.id) : [];
  const memberOfferings = new Set(memberships.map(member => member.offeringId));
  const offerings = courses.flatMap(course => course.offerings.map(offering => ({ course, offering })))
    .sort((a, b) => b.offering.term.startDate.getTime() - a.offering.term.startDate.getTime() || a.course.title.localeCompare(b.course.title, 'zh-CN'));
  const current = offerings.filter(({ offering }) => offering.status === 'ACTIVE');
  const archived = offerings.filter(({ offering }) => offering.status === 'ARCHIVED');

  function courseEntries(items: typeof offerings, historical = false) {
    return <div className={styles.catalogEntries}>{items.map(({ course, offering }) => {
      const member = user?.isAdmin || memberOfferings.has(offering.id);
      const actionLabel = member ? historical ? '查看课程记录' : '进入课程' : '查看开课信息';
      return <Link key={offering.id} className={`${styles.catalogEntry} ${historical ? styles.historicalEntry : ''}`} href={`/courses/${offering.id}`}>
        <div><h2>{offeringCourseTitle({ ...offering, course })}</h2><p className={styles.entryTerm}>{offering.term.name}</p><p className={styles.entryDates}>{displayDate(offering.term.startDate)} — {displayDate(offering.term.endDate)}</p></div>
        <span className={styles.entryAction}>{actionLabel}<span aria-hidden="true">→</span></span>
      </Link>;
    })}</div>;
  }

  return <PageShell currentUser={user}>
    <header className={styles.catalogHeading}><div className="container"><h1>课程</h1></div></header>
    <div className={`container ${styles.catalogBody}`}>
      {current.length ? courseEntries(current) : <p className="empty-state">暂无正在进行的公开课程。</p>}
      {!!archived.length && <details className={styles.catalogArchive} open={!current.length}><summary>往期课程</summary>{courseEntries(archived, true)}</details>}
    </div>
  </PageShell>;
}
