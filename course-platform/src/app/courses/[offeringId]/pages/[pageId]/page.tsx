import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOfferingAccess } from '@/lib/access';
import { getCourseSubpage } from '@/lib/course-subpages';
import { loadCoursePageCatalog } from '@/lib/course-page-catalog';
import { CourseFrame } from '@/components/course-frame';
import { CourseAuthoredPage } from '@/components/course-authored-page';
import { LessonRecords } from '@/components/lesson-records';
import styles from '@/components/course-subpages.module.css';
import { getTeachingLessonReturn, parseTeachingResultSource, teachingResultSourceParams, type TeachingResultSourceQuery } from '@/lib/teaching-result-source';

export default async function CourseSubpageRoute({ params, searchParams }: {
  params: Promise<{ offeringId: string; pageId: string }>;
  searchParams: Promise<TeachingResultSourceQuery & { edit?: unknown; view?: unknown; includeWithdrawn?: unknown }>;
}) {
  const { offeringId, pageId } = await params;
  const query = await searchParams;
  const directory = `/courses/${encodeURIComponent(offeringId)}/pages`;
  const path = `${directory}/${encodeURIComponent(pageId)}`;
  const records = query.view === 'records';
  const origin = parseTeachingResultSource(query);
  const requested = origin ? teachingResultSourceParams(origin) : new URLSearchParams();
  if (records) {
    requested.set('view', 'records');
    if (query.includeWithdrawn === '1') requested.set('includeWithdrawn', '1');
  } else if (query.edit === '1') requested.set('edit', '1');
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, requested.size ? `${path}?${requested}` : path);
  const teachingMember = membership?.status === 'ACTIVE' && (membership.role === 'TEACHER' || membership.role === 'TA');
  if (records && !teachingMember) notFound();
  const { page, canEdit } = await getCourseSubpage(user.id, offeringId, pageId);
  if (!page) notFound();
  const [source, content] = await Promise.all([
    teachingMember && origin ? getTeachingLessonReturn(user.id, offeringId, query) : null,
    records ? null : loadCoursePageCatalog(user, offering, membership, page.id),
  ]);
  const contentHref = source?.params.size ? `${path}?${source.params}` : path;
  const recordParams = new URLSearchParams(source?.params);
  recordParams.set('view', 'records');
  const recordsHref = `${path}?${recordParams}`;
  const title = page.publishedAt ? page.title : page.draft?.title ?? page.title;

  return <CourseFrame user={user} offering={offering} membership={membership} active="lessons" groupSourcePageId={page.id}>
    <div className={styles.lesson}>
      <header className={styles.heading}>
        <Link className={`breadcrumb ${styles.back}`} href={source?.href ?? directory}>← {source?.label ?? '课次'}</Link>
        <h1>{title}</h1>
        {offering.status === 'ARCHIVED' && <p className="field-help">本学期已归档。</p>}
        {records && !page.publishedAt && <p className="field-help">课次草稿</p>}
      </header>
      {teachingMember && <nav className={styles.views} aria-label="课次视图">
        <Link href={contentHref} aria-current={records ? undefined : 'page'}>课程内容</Link>
        <Link href={recordsHref} prefetch={false} aria-current={records ? 'page' : undefined}>课堂记录</Link>
      </nav>}
      {records ? <LessonRecords authorId={user.id} offeringId={offeringId} pageId={page.id}
        includeWithdrawn={query.includeWithdrawn === '1'} recordsHref={recordsHref}/>
        : content && <CourseAuthoredPage externalTitle authorId={user.id} offeringId={offeringId} subpageId={page.id} page={page} catalog={content.catalog}
          canEdit={canEdit} canManageRecords={content.teaching.canManage} courseStatus={offering.status}
          initialIntent={query.edit === '1' ? 'edit' : undefined}/>}
    </div>
  </CourseFrame>;
}
