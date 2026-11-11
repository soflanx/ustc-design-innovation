import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CourseFrame } from '@/components/course-frame';
import { requireOfferingAccess } from '@/lib/access';
import { formatTeachingDate } from '@/lib/teaching-format';
import { DomainError } from '@/lib/management';
import { getStudentTeachingFeedback } from '@/lib/teaching-observations';

export default async function StudentFeedbackPage({ params, searchParams }: {
  params: Promise<{ offeringId: string }>;
  searchParams: Promise<{ fromLearning?: string }>;
}) {
  const { offeringId } = await params;
  const { fromLearning } = await searchParams;
  const base = `/courses/${encodeURIComponent(offeringId)}`;
  const fromRecords = fromLearning === '1';
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, `${base}/feedback${fromRecords ? '?fromLearning=1' : ''}`);
  if (membership?.role !== 'STUDENT') notFound();
  let feedback;
  try { feedback = await getStudentTeachingFeedback(user.id, offeringId); }
  catch (error) { if (error instanceof DomainError) notFound(); throw error; }
  return <CourseFrame user={user} offering={offering} membership={membership} active="feedback">
    <div className="stack">
      <header className="page-heading"><Link className="breadcrumb" href={fromRecords ? `${base}/learning#records` : base}>{fromRecords ? '← 返回本学期记录' : '← 课程首页'}</Link><h1>已保存留言</h1></header>
      {feedback.length ? feedback.map(entry => <article id={`guidance-${entry.id}`} style={{ scrollMarginTop: 100 }} className="panel stack" key={entry.id}>
        <h2>{entry.targetGroup ? entry.targetGroup.name : '个人留言'}</h2>
        <p className="field-help">{entry.author.name} · <time dateTime={entry.createdAt.toISOString()}>{formatTeachingDate(entry.createdAt)}</time></p>
        {entry.recipientBasis === 'CURRENT_GROUP_SHARED' && <p className="field-help">入组后可读的小组留言。</p>}
        {entry.result ? <p><Link href={`/courses/${encodeURIComponent(offeringId)}/assignments/${encodeURIComponent(entry.result.assignmentId)}/submissions/${encodeURIComponent(entry.result.id)}?fromLearning=1`}>{entry.result.title} · 当时的作品</Link></p>
          : entry.hasResultContext && <p>针对当时的成果</p>}
        {entry.context && <p>{entry.context}</p>}
        {entry.body.split(/\n\s*\n/).map((part, index) => <p key={index}>{part}</p>)}
      </article>) : <p className="field-help">暂无已保存留言。</p>}
    </div>
  </CourseFrame>;
}
