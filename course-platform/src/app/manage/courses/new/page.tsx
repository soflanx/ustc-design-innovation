import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageShell } from '@/components/site-shell';
import { CoursePublishForm, type ExistingPresetOffering } from '@/components/course-publish-form';
import { requireUser } from '@/lib/auth';
import { canCreateCourse } from '@/lib/course-creation';
import { COURSE_PRESETS } from '@/lib/course-presets';
import { getPublishablePresetKeys } from '@/lib/course-offering-publication';
import { currentUstcTermKey, loadUstcCalendar } from '@/lib/ustc-calendar';
import { db } from '@/lib/db';
import styles from '@/components/course-publish-form.module.css';

export default async function NewCoursePage({ searchParams }: { searchParams: Promise<{ preset?: string }> }) {
  const user = await requireUser('/manage/courses/new');
  if (!await canCreateCourse(user.id)) notFound();
  const [{ preset }, terms, publishable, courses] = await Promise.all([
    searchParams,
    loadUstcCalendar(),
    getPublishablePresetKeys(user.id),
    db.course.findMany({
      where: { slug: { in: COURSE_PRESETS.map(course => course.slug) } },
      select: { slug: true, offerings: { select: { id: true, status: true, term: { select: { slug: true } } } } },
    }),
  ]);
  const existing: ExistingPresetOffering[] = [];
  for (const course of courses) {
    const identity = COURSE_PRESETS.find(item => item.slug === course.slug);
    if (!identity || !publishable.includes(identity.key)) continue;
    for (const offering of course.offerings) existing.push({
      preset: identity.key, termKey: offering.term.slug, id: offering.id, status: offering.status,
    });
  }
  const initialPreset = preset === 'thinking' || preset === 'practice' ? preset : undefined;
  return <PageShell currentUser={user} context="workspace"><div className={`container ${styles.page}`}>
    <Link className="breadcrumb" href="/workspace?view=all">← 返回我的课程</Link>
    <header className={styles.heading}><h1>发布课程</h1><p>名称和学期已准备好，选一门发布。</p></header>
    <CoursePublishForm terms={terms} currentTermKey={currentUstcTermKey()} publishable={publishable} existing={existing} initialPreset={initialPreset}/>
  </div></PageShell>;
}
