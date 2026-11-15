import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CourseFrame } from '@/components/course-frame';
import { GroupShowcaseStory } from '@/components/group-showcase-story';
import styles from '@/components/group-showcase-story.module.css';
import { PageShell } from '@/components/site-shell';
import { requireOfferingAccess } from '@/lib/access';
import { getCurrentUser } from '@/lib/auth';
import { offeringCourseTitle } from '@/lib/course-label';
import { db } from '@/lib/db';
import { showcaseMaterialHref, showcaseReadHref } from '@/lib/group-showcase-contract';
import { getPublishedGroupShowcase } from '@/lib/group-showcase';

export const dynamic = 'force-dynamic';

export default async function GroupShowcasePage({ params, searchParams }: {
  params: Promise<{ offeringId: string; groupId: string; audience: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const { offeringId, groupId, audience } = await params;
  const scope = audience === 'class' ? 'CLASS' : audience === 'public' ? 'PUBLIC' : null;
  if (!scope) notFound();
  const classroom = scope === 'CLASS'
    ? await requireOfferingAccess(offeringId, false, showcaseReadHref(offeringId, groupId, scope))
    : null;
  const [story, publicOffering, visitor] = await Promise.all([
    getPublishedGroupShowcase(offeringId, groupId, scope, classroom?.user.id),
    classroom ? null : db.courseOffering.findFirst({
      where: { id: offeringId, status: { in: ['ACTIVE', 'ARCHIVED'] } },
      include: { course: true, term: true },
    }),
    classroom ? null : getCurrentUser(),
  ]);
  const offering = classroom?.offering ?? publicOffering;
  if (!story || !offering) notFound();
  const base = `/courses/${encodeURIComponent(offeringId)}`;
  const { from } = await searchParams;
  const back = classroom ? { href: `${base}#group-showcases`, label: '返回本期小组展示' }
    : from === 'projects' ? { href: '/projects', label: '全部项目' }
    : from === 'home' ? { href: '/#projects-title', label: '返回网站首页' }
    : { href: `${base}?view=public#group-showcases`, label: '返回开课信息' };
  const content = <>
    <Link href={back.href} className="breadcrumb" prefetch={false}>
      ← {back.label}
    </Link>
    <GroupShowcaseStory story={story} courseTitle={offeringCourseTitle(offering)} termName={offering.term.name}
      materialHref={material => showcaseMaterialHref(offeringId, groupId, scope, story.publicationId, material.id)}/>
  </>;
  if (classroom) return <CourseFrame user={classroom.user} offering={offering} membership={classroom.membership} active="overview">
    <div className={styles.reading}>{content}</div>
  </CourseFrame>;
  return <PageShell currentUser={visitor}>
    <div className={`container section ${styles.reading}`}>{content}</div>
  </PageShell>;
}
