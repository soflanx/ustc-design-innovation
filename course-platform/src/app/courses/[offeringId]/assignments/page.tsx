import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOfferingAccess } from '@/lib/access';
import { DomainError } from '@/lib/management';
import { getAssignmentIndex } from '@/lib/teaching';
import { createAssignmentAction, updateAssignmentAction } from '@/lib/teaching-actions';
import { formatTeachingDate, toTeachingDateInput } from '@/lib/teaching-format';
import { getAssignmentHomeItems } from '@/lib/teaching-presentation';
import { CourseFrame } from '@/components/course-frame';
import { ActionForm } from '@/components/action-form';
import styles from '@/app/teaching.module.css';

const statuses = { DRAFT: '草稿', PUBLISHED: '已发布', ARCHIVED: '已结束' };
function AssignmentFields({ assignment }: { assignment?: { id: string; title: string; description: string; mode: string; status: string; dueAt: Date | null; versionCount?: number } }) {
  const fieldsKey = JSON.stringify([assignment?.title, assignment?.description, assignment?.mode, assignment?.status, assignment?.dueAt]);
  return <fieldset key={fieldsKey} className={styles.fieldset}><div className="form-field"><label htmlFor={`title-${assignment?.id || 'new'}`}>作业标题</label><input id={`title-${assignment?.id || 'new'}`} name="title" required maxLength={100} defaultValue={assignment?.title}/></div><div className="form-field"><label htmlFor={`description-${assignment?.id || 'new'}`}>作业要求</label><textarea id={`description-${assignment?.id || 'new'}`} name="description" maxLength={12000} rows={5} defaultValue={assignment?.description}/></div><div className={styles.formGrid}><div className="form-field"><label htmlFor={`mode-${assignment?.id || 'new'}`}>提交方式</label><select id={`mode-${assignment?.id || 'new'}`} name="mode" defaultValue={assignment?.mode || 'INDIVIDUAL'}>{(!assignment?.versionCount || assignment.mode === 'INDIVIDUAL') && <option value="INDIVIDUAL">个人作业</option>}{(!assignment?.versionCount || assignment.mode === 'GROUP') && <option value="GROUP">小组作业</option>}</select><p className="field-help">已有提交后不能更改提交方式。</p></div><div className="form-field"><label htmlFor={`due-${assignment?.id || 'new'}`}>截止时间（北京时间）</label><input id={`due-${assignment?.id || 'new'}`} type="datetime-local" name="dueAt" defaultValue={toTeachingDateInput(assignment?.dueAt || null)}/><p className="field-help">留空表示不设截止时间。</p></div></div><div className="form-field"><label htmlFor={`status-${assignment?.id || 'new'}`}>发布状态</label><select id={`status-${assignment?.id || 'new'}`} name="status" defaultValue={assignment?.status || 'DRAFT'}>{(!assignment || assignment.status === 'DRAFT') && <option value="DRAFT">草稿</option>}<option value="PUBLISHED">已发布</option>{assignment && assignment.status !== 'DRAFT' && <option value="ARCHIVED">已结束</option>}</select></div></fieldset>;
}

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
  const isTa = !user.isAdmin && membership?.role === 'TA';
  const assignments = getAssignmentHomeItems(data.assignments, { audience: user.isAdmin ? 'ADMIN' : membership!.role, offeringStatus: offering.status });
  return <CourseFrame user={user} offering={offering} membership={membership} active="assignments"><div className={styles.page}>
    <header className={styles.heading}><h1>作业与反馈</h1></header>
    {offering.status === 'ARCHIVED' && <p className={styles.notice}>本学期已归档，作业与反馈保持只读。</p>}
    {offering.status === 'DRAFT' && <p className={styles.notice}>课程筹备中，暂不接受学生提交。</p>}
    {data.canManage && <details className={styles.editor}><summary>创建作业</summary><div className={`${styles.editorContent} ${styles.section}`}><ActionForm action={createAssignmentAction.bind(null, offeringId)} submitLabel="创建作业"><AssignmentFields/></ActionForm></div></details>}
    <div className={styles.list}>{data.assignments.length ? assignments.map(assignment => <article id={`assignment-${assignment.id}`} className={styles.card} key={assignment.id}>
      <div className={styles.cardHeading}>
        <h2><Link href={`/courses/${offeringId}/assignments/${assignment.id}`}>{assignment.title}</Link></h2>
        <Link className={styles.cardAction} href={assignment.home.href}>{assignment.home.actionLabel} →</Link>
      </div>
      {assignment.description && <p className={styles.excerpt}>{assignment.description}</p>}
      <div className={styles.meta}>
        <span>{assignment.mode === 'GROUP' ? '小组作业' : '个人作业'}</span>
        {assignment.dueAt && <span>截止 {formatTeachingDate(assignment.dueAt)}</span>}
        {isTa && assignment.status !== 'PUBLISHED' && <span>{statuses[assignment.status]}</span>}
        {assignment.home.statusLabel && <span>{assignment.home.statusLabel}</span>}
      </div>
      {data.canManage && <details id={`edit-${assignment.id}`} className={styles.editor} open={editId === assignment.id}><summary>编辑作业</summary><div className={styles.editorContent}><ActionForm action={updateAssignmentAction.bind(null, offeringId, assignment.id)} submitLabel="保存作业"><AssignmentFields assignment={assignment}/></ActionForm></div></details>}
    </article>) : <div className={styles.section}><p className={styles.empty}>{staff ? '本学期尚无作业。' : '暂无已发布的作业。'}</p></div>}</div>
  </div></CourseFrame>;
}
