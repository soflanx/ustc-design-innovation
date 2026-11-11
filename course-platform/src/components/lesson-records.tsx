import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DomainError } from '@/lib/management';
import { getTeachingRecordWorkspace } from '@/lib/teaching-observations';
import { LessonStudentRecordForm } from './lesson-student-record-form';
import { LegacyClassroomDrafts, TeachingObservationForm } from './teaching-observation-form';
import { TeachingRecordsList } from './teaching-records-list';
import { TeachingRecordsNotice } from './teaching-records-notice';
import studentFormStyles from './lesson-student-record-form.module.css';
import styles from './teaching-records.module.css';

export async function LessonRecords({ authorId, offeringId, pageId, includeWithdrawn = false, recordsHref }: {
  authorId: string;
  offeringId: string;
  pageId: string;
  includeWithdrawn?: boolean;
  recordsHref?: string;
}) {
  let data: Awaited<ReturnType<typeof getTeachingRecordWorkspace>>;
  try { data = await getTeachingRecordWorkspace(authorId, offeringId, { pageId, includeWithdrawn: true }); }
  catch (error) { if (error instanceof DomainError) notFound(); throw error; }
  if (!data.filterAvailable) notFound();

  const path = `/courses/${encodeURIComponent(offeringId)}/pages/${encodeURIComponent(pageId)}`;
  const query = new URLSearchParams(recordsHref?.split('?')[1]);
  query.set('view', 'records');
  query.delete('includeWithdrawn');
  const currentHref = `${path}?${query}`;
  query.set('includeWithdrawn', '1');
  const withdrawnHistoryHref = `${path}?${query}`;
  const hasWithdrawn = data.observations.some(note => note.withdrawn);
  const notes = includeWithdrawn ? data.observations : data.observations.filter(note => !note.withdrawn);
  const students = data.students.filter(student => student.status === 'ACTIVE').map(student => ({
    id: student.id, name: student.name, groupName: student.groupMemberships.find(item => !item.leftAt)?.group.name,
  }));
  const lessonTargets = data.archived ? undefined : { students, groups: data.groups };

  return <section className={styles.lessonRecords} aria-labelledby="lesson-records-title">
    <div className={styles.lessonRecordHeader}>
      <h2 id="lesson-records-title">本课记录</h2>
      {(includeWithdrawn || hasWithdrawn) && <Link href={includeWithdrawn ? currentHref : withdrawnHistoryHref} prefetch={false}>
        {includeWithdrawn ? '隐藏已撤回' : '查看已撤回'}
      </Link>}
    </div>
    <TeachingRecordsNotice key={JSON.stringify([authorId, offeringId, pageId])}>
      <div className={styles.lessonRecordBody}>
        <div className={studentFormStyles.entries}>
          <TeachingObservationForm offeringId={offeringId} authorId={authorId} subject={{ pageId }} subjectName="整堂课"
            archived={data.archived} lessonTargets={lessonTargets} summaryLabel="记一笔"/>
          <LessonStudentRecordForm offeringId={offeringId} authorId={authorId} pageId={pageId} students={students} archived={data.archived}/>
        </div>
        <LegacyClassroomDrafts authorId={authorId} offeringId={offeringId} pageId={pageId} lessonTargets={lessonTargets}/>
        <TeachingRecordsList offeringId={offeringId} authorId={authorId} notes={notes}
          historyContext="lesson" withdrawnHistoryHref={withdrawnHistoryHref}/>
      </div>
    </TeachingRecordsNotice>
  </section>;
}
