import type { ReactNode } from 'react';
import type { getAssignmentDetail } from '@/lib/teaching';
import { setSubmissionCorrectionWindowAction } from '@/lib/teaching-actions';
import { formatTeachingDate } from '@/lib/teaching-format';
import { reviewStateLabels } from '@/lib/teaching-presentation';
import { VersionFeedbackForm } from './version-feedback-form';
import { SubmissionCorrectionForm } from './submission-correction-form';
import { SubmissionText } from './submission-text';
import { SubmissionComparison } from './submission-comparison';
import { ReviewStateControls } from './review-state-controls';
import styles from '@/app/teaching.module.css';

const statusLabels = { DRAFT: '草稿', PUBLISHED: '已发布', ARCHIVED: '已结束', CANCELLED: '已取消' };
export type AssignmentVersion = Awaited<ReturnType<typeof getAssignmentDetail>>['versions'][number];
type Version = AssignmentVersion;
type AssignmentRevision = Awaited<ReturnType<typeof getAssignmentDetail>>['revisionHistory'][number];
export type RequirementBodies = ReadonlyMap<string, ReactNode>;

export function RevisionRequirements({ revision, bodies }: { revision: AssignmentRevision; bodies: RequirementBodies }) {
  return <div className={styles.revisionContent}>
    <h4>{revision.title}</h4>
    <div className={styles.meta}><span>{revision.mode === 'GROUP' ? '小组作业' : '个人作业'}</span><span>{revision.dueAt ? `截止 ${formatTeachingDate(revision.dueAt)}` : '不设截止时间'}</span><span>{statusLabels[revision.status]}</span></div>
    <p className={styles.body}>{bodies.get(revision.description) ?? '当时未填写作业要求。'}</p>
    {revision.status === 'CANCELLED' && revision.cancellationReason && <p className={styles.cancellationReason}>取消原因：{revision.cancellationReason}</p>}
  </div>;
}

export function VersionCard({ version, offeringId, assignmentId, reviewerId, bodies, previous, canStartRevision, current, correction, assignmentMode }: {
  version: Version; offeringId: string; assignmentId: string; reviewerId: string | null; bodies: RequirementBodies;
  previous?: Version; canStartRevision: boolean; current: boolean; assignmentMode: AssignmentRevision['mode'];
  correction?: { submissionId: string; correctionUntil: Date | null; correctionRevision: number; paused?: boolean };
}) {
  return <article id={`version-${version.id}`} className={styles.version} data-review-state={version.reviewState.state}>
    <header className={styles.versionHeader}><h3>{version.ownerLabel} · 第 {version.version} 版{current ? ' · 当前提交' : ''}</h3><time dateTime={version.submittedAt.toISOString()}>{formatTeachingDate(version.submittedAt)}</time></header>
    <p className={styles.versionPeople}>提交人：{version.submittedBy.name} · 本次成员：{version.participants.map(person => person.name).join('、')}</p>
    {version.body && <p className={styles.body}><SubmissionText text={version.body}/></p>}
    {version.attachments.length > 0 && <section aria-label="成果附件">
      <h4>成果附件</h4>
      <ul>{version.attachments.map(file => <li key={file.id}><a target="_blank" rel="noopener noreferrer"
        href={`/courses/${encodeURIComponent(offeringId)}/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(version.id)}/files/${encodeURIComponent(file.id)}`}>{file.name}</a></li>)}</ul>
    </section>}
    {correction && reviewerId && <SubmissionCorrectionForm
      action={setSubmissionCorrectionWindowAction.bind(null, offeringId, assignmentId, correction.submissionId)}
      reviewerId={reviewerId} revision={correction.correctionRevision} until={correction.correctionUntil?.toISOString() ?? null} owner={version.ownerLabel} paused={correction.paused}/>}
    {previous && <SubmissionComparison current={version} previous={previous}/>}
    <details className={styles.revisionDetails}>
      <summary>提交时的作业要求{version.assignmentRevision && ` · 第 ${version.assignmentRevision.revision} 版`}</summary>
      {version.assignmentRevision ? <RevisionRequirements revision={version.assignmentRevision} bodies={bodies}/> : <p className={styles.countHelp}>此历史提交未保存当时要求。</p>}
    </details>
    <section className={styles.versionReview} aria-label="本轮评阅状态">
      <div className={styles.versionReviewHeading}><strong>{reviewStateLabels[version.reviewState.state]}</strong>{version.reviewState.updatedBy && <span>{version.reviewState.updatedBy.name}{version.reviewState.updatedAt && ` · ${formatTeachingDate(version.reviewState.updatedAt)}`}</span>}</div>
      {version.reviewState.state === 'LEGACY_UNKNOWN' && <p className={styles.countHelp}>旧文字反馈不能证明评阅已经完成，这份记录未自动计入待评阅。</p>}
      {reviewerId && <ReviewStateControls key={reviewerId} reviewerId={reviewerId} offeringId={offeringId} versionId={version.id} state={version.reviewState.state} revision={version.reviewState.revision}/>}
      {version.reviewHistory.length > 0 && <details className={styles.reviewHistory}><summary>评阅状态记录</summary><ol>{version.reviewHistory.map(event => <li key={event.revision}>{reviewStateLabels[event.state]} · {event.isBaseline ? '历史基线，原完成状态未推断' : event.actor?.name || '提交版本建立'} · {formatTeachingDate(event.createdAt)}</li>)}</ol></details>}
    </section>
    <div className={styles.feedbackList}><h4>评语</h4>
      {version.feedback.length ? version.feedback.map(feedback => <div className={styles.feedback} key={feedback.id}><div className={styles.feedbackMeta}>{feedback.reviewer.name} · {feedback.reviewer.role === 'TA' ? '助教' : '教师'} · <time dateTime={feedback.createdAt.toISOString()}>{formatTeachingDate(feedback.createdAt)}</time></div><p><SubmissionText text={feedback.body}/></p></div>) : <p className={styles.empty}>暂无评语。</p>}
      {reviewerId && <VersionFeedbackForm key={reviewerId} reviewerId={reviewerId} offeringId={offeringId} versionId={version.id}
        recipientLabel={version.ownerLabel} groupSubmission={(version.assignmentRevision?.mode ?? assignmentMode) === 'GROUP'}/>}
    </div>
    {canStartRevision && <div id={`revise-from-${version.id}`}/>}
  </article>;
}

