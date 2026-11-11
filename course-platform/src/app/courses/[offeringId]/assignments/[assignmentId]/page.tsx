import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { requireOfferingAccess } from '@/lib/access';
import { DomainError } from '@/lib/management';
import { getAssignmentDetail } from '@/lib/teaching';
import { submitAssignmentAction } from '@/lib/teaching-actions';
import { canManageOffering } from '@/lib/policy';
import { groupWorkHref } from '@/lib/group-work-link';
import { getGroupActivitySource } from '@/lib/course-subpages';
import { getTeachingResultSource, parseTeachingResultSource, teachingResultSourceParams, type TeachingResultSourceQuery } from '@/lib/teaching-result-source';
import { formatTeachingDate } from '@/lib/teaching-format';
import { assignmentReviewViews, getAssignmentStatistics, progressLabel, reviewStateLabels, type AssignmentReviewScope, type AssignmentReviewView } from '@/lib/teaching-presentation';
import { CourseFrame } from '@/components/course-frame';
import { VersionCard, RevisionRequirements } from '@/components/assignment-version';
import { readAssignmentRequirements } from '@/components/assignment-requirements';
import { AssignmentStatistics } from '@/components/assignment-statistics';
import { SubmissionForm } from '@/components/submission-form';
import { SubmissionHistory } from '@/components/submission-history';
import { previousSubmissionVersions } from '@/lib/submission-comparison';
import styles from '@/app/teaching.module.css';

const statusLabels = { DRAFT: '草稿', PUBLISHED: '已发布', ARCHIVED: '已结束', CANCELLED: '已取消' };
type Version = Awaited<ReturnType<typeof getAssignmentDetail>>['versions'][number];

export default async function AssignmentPage({ params, searchParams }: {
  params: Promise<{ offeringId: string; assignmentId: string }>;
  searchParams: Promise<{ view?: string; scope?: string; fromLearning?: string; fromHome?: string } & TeachingResultSourceQuery>;
}) {
  const { offeringId, assignmentId } = await params;
  const query = await searchParams;
  const requestedSource = parseTeachingResultSource(query);
  const returnQuery = requestedSource ? teachingResultSourceParams(requestedSource) : new URLSearchParams();
  if (typeof query.view === 'string' && Object.hasOwn(assignmentReviewViews, query.view)) returnQuery.set('view', query.view);
  if (query.scope === 'mine' || query.scope === 'all' || query.scope === 'unassigned') returnQuery.set('scope', query.scope);
  if (query.fromLearning === '1') returnQuery.set('fromLearning', '1');
  if (query.fromHome === '1') returnQuery.set('fromHome', '1');
  const returnTo = `/courses/${encodeURIComponent(offeringId)}/assignments/${encodeURIComponent(assignmentId)}${returnQuery.size ? `?${returnQuery}` : ''}`;
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, returnTo);
  let data: Awaited<ReturnType<typeof getAssignmentDetail>>;
  try { data = await getAssignmentDetail(user.id, offeringId, assignmentId); } catch (error) { if (error instanceof DomainError) notFound(); throw error; }
  const { assignment } = data;
  const cancelled = assignment.status === 'CANCELLED';
  const student = !user.isAdmin && membership?.role === 'STUDENT';
  const resultSource = requestedSource && !student ? await getTeachingResultSource(user.id, offeringId, assignmentId, requestedSource) : null;
  const studentPageSource = student && requestedSource?.fromPage
    ? await getGroupActivitySource(user, offeringId, requestedSource.fromPage, membership?.role) : null;
  const studentGroupBack = student && assignment.mode === 'GROUP' && requestedSource?.fromGroup && !requestedSource.fromMember
    && requestedSource.fromGroup === data.currentGroup?.id
    ? groupWorkHref(offeringId, requestedSource.fromPage, requestedSource.fromGroup) : null;
  const fromHome = student && query.fromHome === '1';
  const ta = !user.isAdmin && membership?.role === 'TA';
  const queueScope: AssignmentReviewScope = !ta || query.scope === 'all' ? 'all'
    : query.scope === 'unassigned' && assignment.mode === 'INDIVIDUAL' ? 'unassigned' : 'mine';
  const now = new Date();
  const statistics = getAssignmentStatistics(assignment, data.reviewQueue, { scope: queueScope, offeringStatus: offering.status, now });
  const view: AssignmentReviewView = typeof query.view === 'string' && Object.hasOwn(assignmentReviewViews, query.view)
    && (query.view !== 'missing' || statistics.missingLabel !== null) ? query.view as AssignmentReviewView : 'latest';
  const showStatistics = !student && typeof query.view === 'string' && Object.hasOwn(assignmentReviewViews, query.view);
  const selectedIds = new Set(view === 'history' ? [] : statistics.rows[view].map(row => row.latestVersionId));
  // History shows every readable version. Its filter links carry the queue the reviewer came from.
  const versions = student || view === 'history' ? data.versions : data.versions.filter(row => selectedIds.has(row.id));
  const predecessors = data.canReview && view !== 'history' ? previousSubmissionVersions(data.versions) : null;
  const currentSubmission = student ? data.submissionContext?.latestSubmission : null;
  const revisionVersion = currentSubmission && data.submissionContext?.canSubmit ? versions.find(version => version.id === currentSubmission.id) : undefined;
  const canManageCorrections = data.canReview && offering.status === 'ACTIVE' && assignment.status === 'PUBLISHED'
    && !!assignment.dueAt && assignment.dueAt <= now;
  const correctionByVersion = new Map<string, { submissionId: string; correctionUntil: Date | null; correctionRevision: number; paused?: boolean }>(canManageCorrections
    ? statistics.rows.latest.flatMap(row => row.latestVersionId && row.submissionId
      ? [[row.latestVersionId, { submissionId: row.submissionId, correctionUntil: row.correctionUntil, correctionRevision: row.correctionRevision }] as const] : [])
    : []);
  if (data.canReview && offering.status === 'ACTIVE' && cancelled) {
    for (const row of data.correctionAuthorizations) correctionByVersion.set(row.latestVersionId, { ...row, paused: true });
  }
  const historicalVersions = student ? versions.filter(version => version.id !== currentSubmission?.id) : [];
  function renderVersion(version: Version, current: boolean) {
    return <VersionCard key={version.id} version={version} offeringId={offeringId} assignmentId={assignmentId}
      reviewerId={data.canReview ? user.id : null} bodies={bodies} previous={predecessors?.get(version.id)}
      canStartRevision={revisionVersion?.id === version.id} current={current} assignmentMode={assignment.mode} correction={correctionByVersion.get(version.id)}/>;
  }
  const revisionSource = revisionVersion && {
    versionId: revisionVersion.id,
    feedback: revisionVersion.feedback.map(item => ({
      id: item.id, author: `${item.reviewer.name} · ${item.reviewer.role === 'TA' ? '助教' : '教师'}`, body: item.body,
    })),
  };
  const bodies = await readAssignmentRequirements(user.id, offeringId, [
    assignment.description,
    ...data.revisionHistory.map(revision => revision.description),
    ...versions.map(version => version.assignmentRevision?.description ?? ''),
  ]);
  const requirements = <p className={styles.body}>{bodies.get(assignment.description) ?? '暂未填写作业要求。'}</p>;
  const base = `/courses/${encodeURIComponent(offeringId)}/assignments/${encodeURIComponent(assignmentId)}`;
  function filterHref(nextView: AssignmentReviewView, nextScope = queueScope) {
    const filters = new URLSearchParams(resultSource?.params);
    filters.set('view', nextView); filters.set('scope', nextScope);
    return `${base}?${filters}`;
  }
  const requirementsHref = `${base}${resultSource?.params.size ? `?${resultSource.params}` : ''}`;
  function versionHref(versionId: string) {
    const source = new URLSearchParams(resultSource?.params);
    source.set('view', view); source.set('scope', queueScope);
    source.set('fromStats', '1');
    return `${base}/submissions/${encodeURIComponent(versionId)}?${source}`;
  }

  return <CourseFrame user={user} offering={offering} membership={membership} active="assignments"><div className={styles.page}>
    <header className={styles.heading}>
      {fromHome ? <Link className="breadcrumb" href={`/courses/${encodeURIComponent(offeringId)}#submission-overview`}>← 返回课程首页</Link>
        : <Link className="breadcrumb" href={`/courses/${offeringId}/assignments`}>← 作业</Link>}
      {student && !fromHome && query.fromLearning === '1' && <Link className="breadcrumb" href={`/courses/${encodeURIComponent(offeringId)}/learning#records`}>← 返回本学期记录</Link>}
      {studentGroupBack && <Link className="breadcrumb" href={studentGroupBack}>← 返回我的小组</Link>}
      {studentPageSource && !studentGroupBack && <Link className="breadcrumb" href={`${`/courses/${encodeURIComponent(offeringId)}`}/pages/${encodeURIComponent(studentPageSource.id)}`}>← 返回{studentPageSource.title}</Link>}
      {resultSource && <Link className="breadcrumb" href={resultSource.href}>← 返回{resultSource.name}</Link>}
      <div className={styles.assignmentTitleRow}><h1>{assignment.title}</h1>
        {!student && <Link className="button" href={showStatistics ? requirementsHref : filterHref('latest')}>
          {showStatistics ? '查看作业要求' : '查看提交情况'}
        </Link>}
      </div>
      <div className={styles.assignmentFacts}>
        <span>{assignment.mode === 'GROUP' ? '小组作业' : '个人作业'}</span>
        {assignment.dueAt && <span>截止 <time dateTime={assignment.dueAt.toISOString()}>{formatTeachingDate(assignment.dueAt)}</time></span>}
        {assignment.status !== 'PUBLISHED' && <span>{statusLabels[assignment.status]}</span>}
        {student && assignment.mode === 'GROUP' && (!cancelled || data.currentGroup) && <span>当前小组：{data.currentGroup?.name || '尚未分组'}</span>}
        {offering.status !== 'ARCHIVED' && canManageOffering(user.isAdmin, membership) && <Link href={`/courses/${offeringId}/assignments?edit=${encodeURIComponent(assignmentId)}#edit-${encodeURIComponent(assignmentId)}`}>编辑作业</Link>}
      </div>
    </header>
    {offering.status === 'ARCHIVED' && <p className={styles.notice}>本学期已归档，提交记录与反馈保持只读。</p>}
    {cancelled && <div className={styles.notice}><p>已取消，不再要求完成。</p>{assignment.cancellationReason && <p className={styles.cancellationReason}>取消原因：{assignment.cancellationReason}</p>}</div>}
    {cancelled && student && data.submissionContext?.correctionUntil && <p className={styles.notice}>
      本成果原更正期限为 {formatTeachingDate(data.submissionContext.correctionUntil)}，当前因作业取消暂停。仅恢复发布且未到期时继续生效。
    </p>}
    {cancelled && !student && data.correctionAuthorizations.length > 0 && <section id="correction-authorizations" className={styles.notice}>
      <p>{data.correctionAuthorizations.length} 份成果的更正授权尚未到期，当前因作业取消暂停。仅恢复发布且未到期时继续生效。</p>
      <ul>{data.correctionAuthorizations.map(row => {
        const version = data.versions.find(item => item.id === row.latestVersionId);
        return <li key={row.submissionId}><Link href={`${base}?view=history&scope=all#version-${row.latestVersionId}`}>{version?.ownerLabel ?? '查看成果'}</Link> · 原期限 {formatTeachingDate(row.correctionUntil)}</li>;
      })}</ul>
      {offering.status === 'ACTIVE' && data.canReview && <p>打开对应成果可撤销授权。</p>}
    </section>}
    {showStatistics && <AssignmentStatistics statistics={statistics} mode={assignment.mode} view={view} scope={queueScope}
      isTa={ta} cancelled={cancelled} filterHref={filterHref} versionHref={versionHref}/>}
    <div className={styles.main}>
      {!showStatistics && <section className={styles.section}><h2>作业要求</h2>{requirements}
        <details className={styles.revisionDetails}><summary>修改记录{data.revisionHistory.length > 0 && `（${data.revisionHistory.length}）`}</summary>
          {data.revisionHistory.length ? <ol className={styles.revisionList}>{data.revisionHistory.map(revision => <li key={revision.id}><details className={styles.revisionDetails}><summary>第 {revision.revision} 版 · {statusLabels[revision.status]} · <time dateTime={revision.createdAt.toISOString()}>{formatTeachingDate(revision.createdAt)}</time>{revision.isBaseline && ' · 历史基线'}</summary>{revision.isBaseline && <p className={styles.countHelp}>此时开始保存修改记录，不代表此前提交时的要求。</p>}<RevisionRequirements revision={revision} bodies={bodies}/></details></li>)}</ol> : <p className={styles.countHelp}>此作业尚未保存修改记录。</p>}
        </details>
      </section>}
      {student && <section id="submission" className={styles.section} aria-label="当前作业进度" data-assignment-progress={data.progress?.state}>
        {!cancelled && <p className={styles.progressText}>{progressLabel(data.progress, assignment.mode)}</p>}
        {!cancelled && data.versions.length > 0 && !data.progress?.latestVersionId && <p className={styles.countHelp}>下方保留你参与的历史版本，当前提交记录按现有归属计算。</p>}
        {offering.status !== 'ARCHIVED' && assignment.status === 'PUBLISHED' && assignment.mode === 'GROUP' && !data.currentGroup &&
          <p><Link href={`/courses/${encodeURIComponent(offeringId)}/groups`}>查看组队安排 →</Link></p>}
        {data.submissionContext && <SubmissionForm action={submitAssignmentAction.bind(null, offeringId, assignmentId, user.id)}
          draftKey={`${user.id}:${offeringId}:${assignmentId}`} assignmentHref={base} requestId={randomUUID()}
          context={data.submissionContext} revisionSource={revisionSource} hasCurrentSubmission={Boolean(data.progress?.latestVersionId)}/>}
      </section>}
      {student ? <section className={styles.section}>
        <h2>正式成果与反馈</h2>
        {currentSubmission ? <div className={styles.versions}>{versions.filter(version => version.id === currentSubmission.id).map(version => renderVersion(version, true))}</div>
          : <p className={styles.empty}>当前暂无正式成果。</p>}
        {historicalVersions.length > 0 && <SubmissionHistory count={historicalVersions.length}>
          <div className={styles.versions}>{historicalVersions.map(version => renderVersion(version, false))}</div>
        </SubmissionHistory>}
      </section> : showStatistics && view === 'history' && <section className={styles.section}>
        <h2>各次提交</h2>
        {versions.length ? <div className={styles.queueList}>{versions.map(version => <div className={styles.queueRow} id={`version-${version.id}`} key={version.id}>
          <div><strong>{version.ownerLabel} · 第 {version.version} 版</strong><time dateTime={version.submittedAt.toISOString()}>{formatTeachingDate(version.submittedAt)}</time></div>
          <span>{reviewStateLabels[version.reviewState.state]}</span><Link href={versionHref(version.id)}>查看作品 →</Link>
        </div>)}</div>
          : <p className={styles.empty}>当前筛选下暂无提交记录。</p>}
      </section>}

    </div>
  </div></CourseFrame>;
}
