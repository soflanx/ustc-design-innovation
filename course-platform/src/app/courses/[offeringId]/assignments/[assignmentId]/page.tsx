import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { requireOfferingAccess } from '@/lib/access';
import { DomainError } from '@/lib/management';
import { getAssignmentDetail } from '@/lib/teaching';
import { submitAssignmentAction, addFeedbackAction } from '@/lib/teaching-actions';
import { canManageOffering } from '@/lib/policy';
import { formatTeachingDate } from '@/lib/teaching-format';
import { progressLabel } from '@/lib/teaching-presentation';
import { CourseFrame } from '@/components/course-frame';
import { ActionForm } from '@/components/action-form';
import { SubmissionForm, ReadOnlySubmissionDraft } from '@/components/submission-form';
import styles from '@/app/teaching.module.css';

const statusLabels = { DRAFT: '草稿', PUBLISHED: '已发布', ARCHIVED: '已结束' };
const reviewViews = { latest: '最新提交', pending: '待反馈', missing: '未提交', history: '全部版本' };
type ReviewView = keyof typeof reviewViews;
type Version = Awaited<ReturnType<typeof getAssignmentDetail>>['versions'][number];

function VersionCard({ version, offeringId, canReview }: { version: Version; offeringId: string; canReview: boolean }) {
  return <article id={`version-${version.id}`} className={styles.version}>
    <header className={styles.versionHeader}><h3>{version.ownerLabel} · 第 {version.version} 版</h3><time dateTime={version.submittedAt.toISOString()}>{formatTeachingDate(version.submittedAt)}</time></header>
    <p className={styles.versionPeople}>提交人：{version.submittedBy.name} · 本次成员：{version.participants.map(person => person.name).join('、')}</p>
    <p className={styles.body}>{version.body}</p>
    <div className={styles.feedbackList}><h4>文字反馈</h4>
      {version.feedback.length ? version.feedback.map(feedback => <div className={styles.feedback} key={feedback.id}><div className={styles.feedbackMeta}>{feedback.reviewer.name} · {feedback.reviewer.role === 'TA' ? '助教' : '教师'} · <time dateTime={feedback.createdAt.toISOString()}>{formatTeachingDate(feedback.createdAt)}</time></div><p>{feedback.body}</p></div>) : <p className={styles.empty}>暂无文字反馈。</p>}
      {canReview && <details className={styles.reviewForm}><summary>添加反馈</summary><div className={styles.editorContent}><ActionForm action={addFeedbackAction.bind(null, offeringId, version.id)} submitLabel="发布反馈"><div className="form-field"><label htmlFor={`feedback-${version.id}`}>给此版本的反馈</label><textarea id={`feedback-${version.id}`} name="body" rows={5} maxLength={12000} required/></div></ActionForm></div></details>}
    </div>
  </article>;
}

export default async function AssignmentPage({ params, searchParams }: {
  params: Promise<{ offeringId: string; assignmentId: string }>;
  searchParams: Promise<{ view?: string; scope?: string }>;
}) {
  const { offeringId, assignmentId } = await params;
  const query = await searchParams;
  const returnQuery = new URLSearchParams();
  if (typeof query.view === 'string' && Object.hasOwn(reviewViews, query.view)) returnQuery.set('view', query.view);
  if (query.scope === 'mine' || query.scope === 'all') returnQuery.set('scope', query.scope);
  const returnTo = `/courses/${encodeURIComponent(offeringId)}/assignments/${encodeURIComponent(assignmentId)}${returnQuery.size ? `?${returnQuery}` : ''}`;
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, returnTo);
  let data;
  try { data = await getAssignmentDetail(user.id, offeringId, assignmentId); } catch (error) { if (error instanceof DomainError) notFound(); throw error; }
  const { assignment } = data;
  const student = !user.isAdmin && membership?.role === 'STUDENT';
  const ta = !user.isAdmin && membership?.role === 'TA';
  const view: ReviewView = typeof query.view === 'string' && Object.hasOwn(reviewViews, query.view) ? query.view as ReviewView : 'latest';
  const scope = ta && view !== 'history' && query.scope !== 'all' ? 'mine' : 'all';
  const queue = data.reviewQueue.filter(row => scope === 'all' || row.assignedToMe);
  const submitted = queue.filter(row => row.latestVersionId);
  const pending = submitted.filter(row => !row.feedbackCount);
  const missing = queue.filter(row => !row.latestVersionId);
  const shownQueue = view === 'pending' ? pending : view === 'missing' ? missing : submitted;
  const selectedIds = new Set(shownQueue.map(row => row.latestVersionId));
  const versions = student || view === 'history' ? data.versions : data.versions.filter(row => selectedIds.has(row.id));
  const base = `/courses/${offeringId}/assignments/${assignmentId}`;
  function filterHref(nextView: ReviewView, nextScope = scope) {
    return `${base}?view=${nextView}&scope=${nextView === 'history' ? 'all' : nextScope}`;
  }

  return <CourseFrame user={user} offering={offering} membership={membership} active="assignments"><div className={styles.page}>
    <header className={styles.heading}>
      <Link className="breadcrumb" href={`/courses/${offeringId}/assignments`}>← 作业与反馈</Link>
      <h1>{assignment.title}</h1>
      <div className={styles.assignmentFacts}>
        <span>{assignment.mode === 'GROUP' ? '小组作业' : '个人作业'}</span>
        {assignment.dueAt && <span>截止 <time dateTime={assignment.dueAt.toISOString()}>{formatTeachingDate(assignment.dueAt)}</time></span>}
        {assignment.status !== 'PUBLISHED' && <span>{statusLabels[assignment.status]}</span>}
        {student && assignment.mode === 'GROUP' && <span>当前小组：{data.currentGroup?.name || '尚未分组'}</span>}
        {offering.status !== 'ARCHIVED' && canManageOffering(user.isAdmin, membership) && <Link href={`/courses/${offeringId}/assignments?edit=${encodeURIComponent(assignmentId)}#edit-${encodeURIComponent(assignmentId)}`}>编辑作业</Link>}
      </div>
    </header>
    {offering.status === 'ARCHIVED' && <p className={styles.notice}>本学期已归档，提交记录与反馈保持只读。</p>}
    {!student && <section className={styles.reviewOverview} aria-label="提交概况" data-review-view={view} data-review-scope={scope}>
      <div className={styles.reviewHeading}><h2>提交概况</h2>{ta && view !== 'history' && <nav className={styles.scopeSwitch} aria-label="查看范围"><Link href={filterHref(view, 'mine')} aria-current={scope === 'mine' ? 'page' : undefined}>我负责的小组</Link><Link href={filterHref(view, 'all')} aria-current={scope === 'all' ? 'page' : undefined}>全班</Link></nav>}</div>
      <p className={styles.countHelp}>当前范围：{queue.length} {assignment.mode === 'GROUP' ? '个有效小组' : '名有效学生'}。</p>
      <nav className={styles.reviewFilters} aria-label="提交筛选">{Object.entries(reviewViews).map(([key, label]) => <Link key={key} href={filterHref(key as ReviewView)} aria-current={view === key ? 'page' : undefined}>{label}{key !== 'history' && <span className={styles.filterCount}> ({key === 'latest' ? submitted.length : key === 'pending' ? pending.length : missing.length})</span>}</Link>)}</nav>
      <details className={styles.countDefinition}><summary>统计口径</summary><p>按当前有效成员或小组的最新版本统计，新版本需单独反馈。全部版本保留已退出成员和小组的历史记录。</p></details>
      {view === 'history' ? <p className={styles.historyHelp}>显示本期全部历史版本，包括已退出成员和小组的记录。</p> : shownQueue.length ? <div className={styles.queueList}>{shownQueue.map(row => <div className={styles.queueRow} data-submission-owner={row.id} key={row.id}><div><strong>{row.ownerLabel}</strong>{row.submittedAt && <time dateTime={row.submittedAt.toISOString()}>{formatTeachingDate(row.submittedAt)}</time>}</div><span>{row.latestVersionId ? row.feedbackCount ? `第 ${row.latestVersionNumber} 版 · 已反馈` : `第 ${row.latestVersionNumber} 版 · 待反馈` : '尚未提交'}</span>{row.latestVersionId && <a href={`#version-${row.latestVersionId}`}>查看 →</a>}</div>)}</div> : <p className={styles.empty}>{scope === 'mine' && !queue.length ? '当前没有分配给你的有效小组，可切换到全班查看。' : view === 'pending' ? '当前范围内没有待反馈的最新版本。' : view === 'missing' ? '当前范围内没有未提交的成员或小组。' : '当前范围内暂无提交。'}</p>}
    </section>}
    <div className={styles.main}>
      <section className={styles.section}>{student ? <><h2>作业要求</h2><p className={styles.body}>{assignment.description || '暂未填写作业要求。'}</p></> : <details className={styles.requirements}><summary>作业要求</summary><p className={styles.body}>{assignment.description || '暂未填写作业要求。'}</p></details>}</section>
      {student && <section id="submission" className={styles.section} aria-label="当前作业进度" data-assignment-progress={data.progress?.state}>
        <p className={styles.progressText}>{progressLabel(data.progress, assignment.mode)}</p>
        {data.versions.length > 0 && !data.progress?.latestVersionId && <p className={styles.countHelp}>下方保留你参与的历史版本，当前提交记录按现有归属计算。</p>}
        <details className={styles.submissionEditor} open={!data.progress?.latestVersionId}><summary>{!data.canSubmit ? '查看本浏览器草稿' : data.progress?.latestVersionId ? '提交新版本' : '提交作业'}</summary><div className={styles.editorContent}>
          {data.canSubmit ? <SubmissionForm action={submitAssignmentAction.bind(null, offeringId, assignmentId)} draftKey={`${user.id}:${offeringId}:${assignmentId}`} requestId={randomUUID()} expectedGroupId={assignment.mode === 'GROUP' ? data.currentGroup?.id : null} groupName={assignment.mode === 'GROUP' ? data.currentGroup?.name : undefined}/> : <ReadOnlySubmissionDraft draftKey={`${user.id}:${offeringId}:${assignmentId}`} reason={data.submissionBlockedReason || '当前不可提交。'}/>}
        </div></details>
        {assignment.mode === 'GROUP' && !data.currentGroup && <p className={styles.countHelp}>尚未分组。<Link href={`/courses/${offeringId}/team`}>查看教学团队</Link> · <Link href={`/courses/${offeringId}/groups`}>查看我的小组</Link></p>}
      </section>}
      {(student || view === 'history' || versions.length > 0) && <section className={styles.section}><h2>{student ? '提交记录与反馈' : reviewViews[view]}</h2>{versions.length ? <div className={styles.versions}>{versions.map(version => <VersionCard key={version.id} version={version} offeringId={offeringId} canReview={data.canReview}/>)}</div> : <p className={styles.empty}>{student ? '暂无你可查看的提交记录。' : '当前筛选下暂无提交版本。'}</p>}</section>}
    </div>
  </div></CourseFrame>;
}
