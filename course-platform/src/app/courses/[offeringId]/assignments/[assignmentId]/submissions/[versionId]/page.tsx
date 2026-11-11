import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOfferingAccess } from '@/lib/access';
import { DomainError } from '@/lib/management';
import { getAssignmentDetail } from '@/lib/teaching';
import { getGroupActivitySource } from '@/lib/course-subpages';
import { groupWorkHref, parseGroupSource } from '@/lib/group-work-link';
import { previousSubmissionVersions } from '@/lib/submission-comparison';
import { assignmentReviewViews } from '@/lib/teaching-presentation';
import { getTeachingResultSource, parseTeachingResultSource, teachingResultSourceParams, type TeachingResultSourceQuery } from '@/lib/teaching-result-source';
import { CourseFrame } from '@/components/course-frame';
import { VersionCard } from '@/components/assignment-version';
import { readAssignmentRequirements } from '@/components/assignment-requirements';
import styles from '@/app/teaching.module.css';

type Query = TeachingResultSourceQuery & {
  view?: string; scope?: string; fromStats?: string; fromLearning?: string; fromHome?: string; fromVersion?: unknown;
};

export default async function SubmissionVersionPage({ params, searchParams }: {
  params: Promise<{ offeringId: string; assignmentId: string; versionId: string }>;
  searchParams: Promise<Query>;
}) {
  const { offeringId, assignmentId, versionId } = await params;
  const query = await searchParams;
  const course = `/courses/${encodeURIComponent(offeringId)}`;
  const assignmentHref = `${course}/assignments/${encodeURIComponent(assignmentId)}`;
  const path = `${assignmentHref}/submissions/${encodeURIComponent(versionId)}`;
  const requestedSource = parseTeachingResultSource(query);
  const fromVersion = requestedSource?.fromMember || requestedSource?.fromGroup ? parseGroupSource(query.fromVersion) : undefined;
  const sourceParams = requestedSource ? teachingResultSourceParams(requestedSource) : new URLSearchParams();
  if (fromVersion) sourceParams.set('fromVersion', fromVersion);
  if (typeof query.view === 'string' && Object.hasOwn(assignmentReviewViews, query.view)) sourceParams.set('view', query.view);
  if (query.scope === 'all' || query.scope === 'mine' || query.scope === 'unassigned') sourceParams.set('scope', query.scope);
  for (const key of ['fromStats', 'fromLearning', 'fromHome'] as const) if (query[key] === '1') sourceParams.set(key, '1');
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, `${path}${sourceParams.size ? `?${sourceParams}` : ''}`);
  let data;
  try { data = await getAssignmentDetail(user.id, offeringId, assignmentId); }
  catch (error) { if (error instanceof DomainError) notFound(); throw error; }
  // The assignment service returns only finalized versions this viewer may read,
  // including actual former participants. A URL never widens that result.
  const version = data.versions.find(item => item.id === versionId);
  if (!version) notFound();
  const student = !user.isAdmin && membership?.role === 'STUDENT';
  const resultSource = !student && requestedSource
    ? await getTeachingResultSource(user.id, offeringId, assignmentId, requestedSource, versionId, fromVersion) : null;
  const otherVersionParams = new URLSearchParams(sourceParams);
  otherVersionParams.delete('fromVersion');
  if (resultSource?.sourceVersionId) otherVersionParams.set('fromVersion', resultSource.sourceVersionId);
  const pageSource = student && requestedSource?.fromPage
    ? await getGroupActivitySource(user, offeringId, requestedSource.fromPage, membership?.role) : null;
  const fromStats = !student && query.fromStats === '1';
  const statsParams = new URLSearchParams(resultSource?.params);
  statsParams.set('view', typeof query.view === 'string' && Object.hasOwn(assignmentReviewViews, query.view) ? query.view : 'latest');
  statsParams.set('scope', query.scope === 'all' || query.scope === 'mine' || query.scope === 'unassigned' ? query.scope : membership?.role === 'TA' ? 'mine' : 'all');

  let back = { href: assignmentHref, label: '返回作业要求' };
  if (fromStats) back = { href: `${assignmentHref}?${statsParams}`, label: '返回提交情况' };
  else if (resultSource) back = { href: resultSource.href, label: `返回${resultSource.name}` };
  else if (student && query.fromHome === '1') back = { href: `${course}#submission-overview`, label: '返回课程首页' };
  else if (student && query.fromLearning === '1') back = { href: `${course}/learning#records`, label: '返回本学期记录' };
  else if (student && requestedSource?.fromGroup && data.currentGroup && requestedSource.fromGroup === data.currentGroup.id && !requestedSource.fromMember) {
    back = { href: groupWorkHref(offeringId, pageSource?.id, data.currentGroup.id), label: '返回我的小组' };
  } else if (pageSource) back = { href: `${course}/pages/${encodeURIComponent(pageSource.id)}`, label: `返回${pageSource.title}` };

  const current = data.reviewQueue.some(row => row.latestVersionId === versionId) || data.submissionContext?.latestSubmission?.id === versionId;
  const row = data.reviewQueue.find(item => item.latestVersionId === versionId);
  const now = new Date();
  const cancelledAuthorization = data.correctionAuthorizations.find(item => item.latestVersionId === versionId);
  const correction = data.canReview && offering.status === 'ACTIVE'
    ? data.assignment.status === 'CANCELLED' && cancelledAuthorization
      ? { ...cancelledAuthorization, paused: true }
      : data.assignment.status === 'PUBLISHED' && data.assignment.dueAt && data.assignment.dueAt <= now && row?.submissionId
        ? { submissionId: row.submissionId, correctionUntil: row.correctionUntil, correctionRevision: row.correctionRevision }
        : undefined
    : undefined;
  const bodies = await readAssignmentRequirements(user.id, offeringId, [version.assignmentRevision?.description ?? '']);
  const previous = data.canReview ? previousSubmissionVersions(data.versions).get(versionId) : undefined;
  const otherVersions = data.versions.filter(item => item.submissionId === version.submissionId && item.id !== versionId);
  const currentTitle = version.assignmentRevision?.title ?? data.assignment.title;

  return <CourseFrame user={user} offering={offering} membership={membership} active="assignments">
    <div className={styles.page}>
      <header className={styles.heading}>
        <Link className="breadcrumb" href={back.href}>← {back.label}</Link>
        <h1>{currentTitle}</h1>
        <div className={styles.assignmentFacts}>
          <span>{(version.assignmentRevision?.mode ?? data.assignment.mode) === 'GROUP' ? '小组作品' : '个人作品'}</span>
          <Link href={assignmentHref}>查看当前作业要求</Link>
        </div>
      </header>
      {offering.status === 'ARCHIVED' && <p className={styles.notice}>本学期已归档，作品和评语保持只读。</p>}
      {data.assignment.status === 'CANCELLED' && <p className={styles.notice}>作业已取消，保留这次提交和评语。</p>}
      <VersionCard version={version} offeringId={offeringId} assignmentId={assignmentId} reviewerId={data.canReview ? user.id : null}
        bodies={bodies} previous={previous} canStartRevision={false} current={current} assignmentMode={data.assignment.mode} correction={correction}/>
      {student && data.submissionContext?.canSubmit && data.submissionContext.latestSubmission?.id === versionId &&
        <p className={styles.savedRecord}><Link href={`${assignmentHref}#submission`}>更正这份提交 →</Link></p>}
      {otherVersions.length > 0 && <details className={styles.revisionDetails}>
        <summary>同一份作品的其他版本（{otherVersions.length}）</summary>
        <ul>{otherVersions.map(item => <li key={item.id}><Link href={`${assignmentHref}/submissions/${encodeURIComponent(item.id)}${otherVersionParams.size ? `?${otherVersionParams}` : ''}`}>第 {item.version} 版 · {item.submittedBy.name}</Link></li>)}</ul>
      </details>}
    </div>
  </CourseFrame>;
}
