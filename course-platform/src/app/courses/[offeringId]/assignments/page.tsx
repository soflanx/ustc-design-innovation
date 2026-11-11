import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOfferingAccess } from '@/lib/access';
import { DomainError } from '@/lib/management';
import { getAssignmentIndex } from '@/lib/teaching';
import { assignmentMaterialText } from '@/lib/assignment-material-links';
import { db } from '@/lib/db';
import { updateAssignmentAction } from '@/lib/teaching-actions';
import { formatTeachingDate } from '@/lib/teaching-format';
import { getAssignmentHomeItems, reviewStateLabels } from '@/lib/teaching-presentation';
import { CourseFrame } from '@/components/course-frame';
import { AssignmentEditForm } from '@/components/assignment-fields';
import styles from '@/app/teaching.module.css';

export default async function AssignmentsPage({ params, searchParams }: {
  params: Promise<{ offeringId: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const { offeringId } = await params;
  const { edit } = await searchParams;
  const editId = typeof edit === 'string' ? edit.trim().slice(0, 200) : '';
  const returnTo = `/courses/${offeringId}/assignments${editId ? `?${new URLSearchParams({ edit: editId })}#edit-${encodeURIComponent(editId)}` : ''}`;
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, returnTo);
  let data;
  try { data = await getAssignmentIndex(user.id, offeringId); } catch (error) { if (error instanceof DomainError) notFound(); throw error; }
  const staff = user.isAdmin || membership?.role === 'TEACHER' || membership?.role === 'TA';
  const materials = data.canManage ? await db.resource.findMany({
    where: { offeringId, status: 'PUBLISHED' }, select: { id: true, title: true }, orderBy: [{ title: 'asc' }, { id: 'asc' }],
  }) : [];
  const assignments = getAssignmentHomeItems(data.assignments, { audience: user.isAdmin ? 'ADMIN' : membership!.role, offeringStatus: offering.status });
  return <CourseFrame user={user} offering={offering} membership={membership} active="assignments"><div className={styles.page}>
    <header className={data.canManage ? `${styles.heading} ${styles.assignmentListHeading}` : styles.heading}><h1>作业</h1>
      {data.canManage && <Link className="button primary" href={`/courses/${encodeURIComponent(offeringId)}?create=assignment`}>布置作业</Link>}
    </header>
    {offering.status === 'ARCHIVED' && <p className={styles.notice}>本学期已归档，作业与反馈保持只读。</p>}
    {offering.status === 'DRAFT' && <p className={styles.notice}>课程筹备中，暂不接受学生提交。</p>}
    <div className={styles.list}>{data.assignments.length ? assignments.map(assignment => <article id={`assignment-${assignment.id}`} className={styles.card} key={assignment.id}>
      <div className={styles.cardHeading}>
        <h2><Link href={`/courses/${offeringId}/assignments/${assignment.id}`}>{assignment.title}</Link></h2>
        <Link className={styles.cardAction} href={staff
          ? `/courses/${encodeURIComponent(offeringId)}/assignments/${encodeURIComponent(assignment.id)}?view=latest&scope=${membership?.role === 'TA' && !user.isAdmin ? 'mine' : 'all'}`
          : assignment.home.href}>{staff ? '查看提交情况' : assignment.home.actionLabel} →</Link>
      </div>
      {assignment.description && <p className={styles.excerpt}>{assignmentMaterialText(assignment.description, offeringId)}</p>}
      {assignment.status === 'CANCELLED' && assignment.cancellationReason && <p className={styles.cancellationReason}>取消原因：{assignment.cancellationReason}</p>}
      <div className={styles.meta}>
        <span>{assignment.mode === 'GROUP' ? '小组作业' : '个人作业'}</span>
        {assignment.dueAt && <span>截止 {formatTeachingDate(assignment.dueAt)}</span>}
        <span>{assignment.home.lifecycleLabel}</span>
        {!staff && assignment.progress?.latestVersionId
          ? <span>{assignment.mode === 'GROUP' ? '当前小组已交' : '本人已交'}
            {assignment.progress.feedbackCount > 0 && ` · 有 ${assignment.progress.feedbackCount} 条反馈`}
            {assignment.progress.reviewState && ` · ${reviewStateLabels[assignment.progress.reviewState]}`}
          </span>
          : assignment.home.statusLabel && assignment.home.statusLabel !== assignment.home.lifecycleLabel && <span>{assignment.home.statusLabel}</span>}
      </div>
      {assignment.unassignedSummary && assignment.unassignedSummary.totalExpectedCount > 0 && <p className="field-help">
        <Link href={`/courses/${encodeURIComponent(offeringId)}/assignments/${encodeURIComponent(assignment.id)}?view=latest&scope=unassigned`}>
          未分组学生 · 已交 {assignment.unassignedSummary.submittedCount}/{assignment.unassignedSummary.totalExpectedCount} 人
          {offering.status === 'ACTIVE' && assignment.unassignedSummary.pendingFeedbackCount > 0 && ` · 待评阅 ${assignment.unassignedSummary.pendingFeedbackCount}`} →
        </Link>
      </p>}
      {staff && assignment.status === 'CANCELLED' && (assignment.pendingCorrectionCount ?? 0) > 0 && <p className="field-help">
        {assignment.pendingCorrectionCount} 份尚未到期的更正授权已暂停，恢复发布且未到期时继续生效。{' '}
        <Link href={`/courses/${offeringId}/assignments/${assignment.id}?view=history&scope=all#correction-authorizations`}>检查授权 →</Link>
      </p>}
      {data.canManage && <details id={`edit-${assignment.id}`} className={styles.editor} open={editId === assignment.id}><summary>编辑作业</summary><div className={styles.editorContent}><AssignmentEditForm assignment={assignment} materials={materials} saveAction={updateAssignmentAction.bind(null, offeringId, assignment.id, user.id)}/></div></details>}
    </article>) : <div className={styles.section}><p className={styles.empty}>{staff ? '本学期尚无作业。' : '暂无已发布的作业。'}</p></div>}</div>
  </div></CourseFrame>;
}
