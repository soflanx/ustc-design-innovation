import { CourseFrame } from '@/components/course-frame';
import { CourseLessonStarter } from '@/components/course-weekly-preparation';
import { CourseSubpageIndex } from '@/components/course-subpage-index';
import styles from '@/components/course-subpages.module.css';
import { requireOfferingAccess } from '@/lib/access';
import { loadCoursePageCatalog } from '@/lib/course-page-catalog';
import { listCourseSubpages } from '@/lib/course-subpages';

export default async function CourseLessonsRoute({ params }: { params: Promise<{ offeringId: string }> }) {
  const { offeringId } = await params;
  const href = `/courses/${encodeURIComponent(offeringId)}/pages`;
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, href);
  const { pages, canEdit } = await listCourseSubpages(user.id, offeringId);
  const canReadRecords = membership?.status === 'ACTIVE' && (membership.role === 'TEACHER' || membership.role === 'TA');
  const catalog = canEdit ? (await loadCoursePageCatalog(user, offering, membership)).catalog : null;

  return <CourseFrame user={user} offering={offering} membership={membership} active="lessons">
    <div className={styles.directory}>
      <h1>课次</h1>
      {offering.status === 'ARCHIVED' && <p className="field-help">本学期已归档。</p>}
      {catalog && <CourseLessonStarter offeringId={offeringId} authorId={user.id}
        assignments={catalog.assignments.filter(item => item.visibilityStatus === 'PUBLISHED').map(({ id, title }) => ({ id, title }))}
        resources={catalog.resources.filter(item => item.visibilityStatus === 'PUBLISHED').map(({ id, title }) => ({ id, title }))}/>}
      <CourseSubpageIndex offeringId={offeringId} pages={pages} canReadRecords={canReadRecords}/>
    </div>
  </CourseFrame>;
}
