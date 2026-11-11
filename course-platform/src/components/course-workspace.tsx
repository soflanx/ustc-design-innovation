import Link from 'next/link';
import type { CourseMember, Prisma } from '@prisma/client';
import { getCourseFocus } from '@/lib/course-focus';
import { loadCoursePageCatalog } from '@/lib/course-page-catalog';
import { listCourseSubpages } from '@/lib/course-subpages';
import { courseSubpageReference } from '@/lib/course-document-view';
import { formatTeachingDate } from '@/lib/teaching-format';
import { getGroupFormationWindow } from '@/lib/group-formation';
import { offeringCourseTitle } from '@/lib/course-label';
import { CourseFrame } from './course-frame';
import { CourseAuthoredPage } from './course-authored-page';
import type { CourseEditorIntent } from './course-focus-editor';
import type { SiteUser } from './site-shell';
import styles from './current-teaching.module.css';

type Offering = Prisma.CourseOfferingGetPayload<{ include: { course: true; term: true } }>;

export async function CourseWorkspace({ offering, user, membership, initialIntent }: {
  offering: Offering;
  user: SiteUser & { id: string; isAdmin: boolean };
  membership: CourseMember | null;
  initialIntent?: CourseEditorIntent;
}) {
  const student = !user.isAdmin && membership?.role === 'STUDENT';
  const archived = offering.status === 'ARCHIVED';
  const [{ catalog: records, teaching }, focusData, pageIndex] = await Promise.all([
    loadCoursePageCatalog(user, offering, membership),
    getCourseFocus(user.id, offering.id),
    listCourseSubpages(user.id, offering.id),
  ]);
  const catalog = { ...records, pages: pageIndex.pages.map(page => courseSubpageReference(offering.id, page)) };
  const { focus, canEdit } = focusData;
  const base = `/courses/${encodeURIComponent(offering.id)}`;
  const formation = student && !catalog.groups.length ? getGroupFormationWindow(offering) : null;
  const receipt = student ? teaching.assignments.flatMap(({ id, title, latestVersion }) => latestVersion
    ? [{ id, title: latestVersion.assignmentRevision?.title ?? title, version: latestVersion }] : [])
    .sort((a, b) => b.version.submittedAt.getTime() - a.version.submittedAt.getTime())[0] : undefined;

  return <CourseFrame user={user} offering={offering} membership={membership} active="overview"><div className={styles.page} data-workspace-role={user.isAdmin ? 'ADMIN' : membership?.role}>
    {archived && <p className={styles.notice}>本学期已归档，教学内容、提交和反馈保持只读。</p>}
    {offering.status === 'DRAFT' && <p className={styles.notice}>课程筹备中，暂不接受学生提交。</p>}
    <div data-student-home={student || undefined}>
      <CourseAuthoredPage authorId={user.id} offeringId={offering.id} page={student && !focus?.publishedAt ? null : focus} catalog={catalog}
        canEdit={canEdit} canManageRecords={teaching.canManage} courseStatus={offering.status} initialIntent={initialIntent}
        fallbackTitle={offeringCourseTitle(offering)}/>
      {student && (formation || catalog.assignments.length > 0) && <div id="submission-overview" className={styles.homeLinks}>
        {formation && <p><Link href={`${base}/groups`}>开始组队</Link>{' · '}<time dateTime={formation.closesAt.toISOString()}>截止 {formatTeachingDate(formation.closesAt)}</time></p>}
        {catalog.assignments.length > 0 && <Link href={`${base}/assignments`}>查看作业与提交情况 →</Link>}
        {receipt && <Link href={`${base}/assignments/${encodeURIComponent(receipt.id)}/submissions/${encodeURIComponent(receipt.version.id)}?fromHome=1`}>最近成果 · {receipt.title} →</Link>}
      </div>}
    </div>
  </div></CourseFrame>;
}
