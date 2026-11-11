import Link from 'next/link';
import { Fragment } from 'react';
import { courseLessonHref, groupWorkHref } from '@/lib/group-work-link';
import { displayDate } from '@/lib/policy';
import { teachingHistoryOverview, type TeachingHistory } from '@/lib/teaching-history';
import { SubmissionText } from './submission-text';
import { TeachingObservationForm, type TeachingSubject } from './teaching-observation-form';
import { TeachingRecordsList } from './teaching-records-list';
import styles from './teaching-history.module.css';

type Observation = TeachingHistory['observations'][number];

function reviewExcerpt(body: string) {
  const text = [...body.trim().replace(/\s+/gu, ' ')];
  return text.length > 140 ? `${text.slice(0, 140).join('')}…` : text.join('');
}

export function TeachingObservationPanel({
  offeringId, authorId, subject, name, history, origin, archived, showEmpty = true,
  sourcePageId, sourcePageTitle, sourceGroupId, sourceGroupName, withdrawnHistoryHref,
}: {
  offeringId: string; authorId: string; subject: TeachingSubject; name: string;
  history: TeachingHistory; origin: URLSearchParams; archived: boolean; showEmpty?: boolean;
  sourcePageId?: string; sourcePageTitle?: string; sourceGroupId?: string; sourceGroupName?: string;
  withdrawnHistoryHref?: string;
}) {
  const base = `/courses/${encodeURIComponent(offeringId)}`;
  const { lessons, remarks, unlinkedClassroomNotes, submissions, otherVersionNotes } = teachingHistoryOverview(history);
  const messages = history.guidance;
  const recipients = new Set(messages.map(entry => entry.targetGroup?.id ?? null));
  const sentTo = recipients.size === 1 ? messages[0]?.targetGroup?.name ?? `${name}本人`
    : recipients.has(null) ? `${name}本人和小组` : '小组';
  const hasClassroomNotes = lessons.length > 0 || unlinkedClassroomNotes.length > 0;
  const hasWork = submissions.length > 0 || otherVersionNotes.length > 0;
  const resultHref = (assignmentId: string, versionId: string) =>
    `${base}/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(versionId)}${origin.size ? `?${origin}` : ''}`;
  const lessonHref = (pageId: string) => courseLessonHref(offeringId, pageId, true, origin);
  const contextGroupHref = history.member
    ? (groupId: string) => `${groupWorkHref(offeringId, undefined, groupId)}?${origin}` : undefined;

  function notes(rows: Observation[], placement: 'lesson' | 'result' | 'standalone') {
    if (!rows.length) return null;
    return <TeachingRecordsList offeringId={offeringId} authorId={authorId} notes={rows}
      historyContext={history.member ? 'member' : 'group'} historyPlacement={placement}
      resultHref={resultHref} lessonHref={lessonHref} contextGroupHref={contextGroupHref} withdrawnHistoryHref={withdrawnHistoryHref}/>;
  }

  const oldDraft = { offeringId, authorId, subject, subjectName: name, archived, draftOnly: true };

  return <>
    {remarks.length > 0 && <section className={styles.historySection} aria-labelledby="teaching-remarks">
      <h2 id="teaching-remarks">{history.member ? '个人备注' : '小组备注'}</h2>
      {notes(remarks, 'standalone')}
    </section>}
    {hasClassroomNotes && <section className={styles.historySection} aria-labelledby="teaching-classroom">
      <h2 id="teaching-classroom">课堂记录</h2>
      <ol className={styles.history}>
        {lessons.map(item => <li key={item.key} className={styles.entry}>
          <h3><Link href={lessonHref(item.page.id)} prefetch={false}>{item.page.title}</Link>{!item.page.publishedAt && '（草稿）'}</h3>
          {notes(item.notes, 'lesson')}
        </li>)}
        {unlinkedClassroomNotes.length > 0 && <li className={styles.entry}>
          <h3>未关联课次的旧记录</h3>
          {notes(unlinkedClassroomNotes, 'standalone')}
        </li>}
      </ol>
    </section>}
    {hasWork && <section className={styles.historySection} aria-labelledby="teaching-submissions">
      <h2 id="teaching-submissions">作业与评语</h2>
      {submissions.length > 0 && <ol className={styles.history}>{submissions.map(({ result, earlier, versionNotes }) => {
        const { assignment, group } = result.submission;
        const reviewedVersion = result.reviews.length ? result : earlier.find(version => version.reviews.length > 0);
        const latestReview = reviewedVersion?.reviews.at(-1);
        const oldReview = reviewedVersion && reviewedVersion.id !== result.id;
        return <li key={result.submission.id} className={styles.entry}>
          <h3><Link href={resultHref(assignment.id, result.id)} prefetch={false}>
            {result.assignmentRevision?.title ?? assignment.title}
          </Link></h3>
          <p className={styles.meta}>{group ? `${history.member ? group.name : '小组'}提交` : '个人提交'}</p>
          {latestReview && <p className={styles.reviewPreview}><span>{oldReview ? '旧版评语' : '评语'}</span> {reviewExcerpt(latestReview.body)}</p>}
          <details className={styles.resultDetails} open={versionNotes.some(item => item.notes.some(note => note.withdrawn))}>
            <summary>{latestReview ? '查看完整评语与提交详情' : '查看提交详情'}</summary>
            <div className={styles.expanded}>
              {oldReview && <p className={styles.meta}>
                <Link href={resultHref(assignment.id, reviewedVersion.id)} prefetch={false}>第 {reviewedVersion.version} 版的评语</Link>
              </p>}
              {reviewedVersion && <ul className={styles.reviews} aria-label={oldReview ? '旧版评语' : '本版评语'}>{reviewedVersion.reviews.toReversed().map(review => <li key={review.id}>
                <p className={styles.body}><SubmissionText text={review.body}/></p>
                <p className={styles.meta}>{review.reviewer.user.name} · <time dateTime={review.createdAt.toISOString()}>{displayDate(review.createdAt)}</time></p>
              </li>)}</ul>}
              <p className={styles.meta}>第 {result.version} 版 · {result.submittedBy.user.name}提交 ·{' '}
                <time dateTime={result.submittedAt.toISOString()}>{displayDate(result.submittedAt)}</time>
              </p>
              {earlier.length > 0 && <ul className={styles.versions} aria-label="本次回顾的旧版本">{earlier.map(version => <li key={version.id}>
                <Link href={resultHref(assignment.id, version.id)} prefetch={false}>第 {version.version} 版</Link> · {version.submittedBy.user.name}提交 ·{' '}
                <time dateTime={version.submittedAt.toISOString()}>{displayDate(version.submittedAt)}</time>
                {version.reviews.length > 0 && ' · 有评语'}
              </li>)}</ul>}
              {versionNotes.length > 0 && <section className={styles.versionNotes} aria-label="教学备注">
                <h4>教学备注</h4>
                {versionNotes.map(({ version, notes: rows }) => <div key={version.id}>
                  <p className={styles.meta}><Link href={resultHref(assignment.id, version.id)} prefetch={false}>第 {version.version} 版原件</Link></p>
                  {notes(rows, 'result')}
                </div>)}
              </section>}
            </div>
          </details>
        </li>;
      })}</ol>}
      {otherVersionNotes.length > 0 && <details className={styles.resultDetails} open={otherVersionNotes.some(note => note.withdrawn)}>
        <summary>关联其他作品的教学备注</summary>
        <div className={styles.expanded}>{notes(otherVersionNotes, 'standalone')}</div>
      </details>}
    </section>}
    {messages.length > 0 && <details className={styles.pastMessages}>
      <summary>以前发给{sentTo}的留言</summary>
      <ul className={styles.history}>{messages.map(entry => {
        const assignment = entry.version?.submission.assignment;
        return <li className={styles.entry} key={entry.id}>
          <p className={styles.body}>{entry.body}</p>
          {entry.context && <p className={styles.meta}>{entry.context}</p>}
          <p className={styles.meta}>
            {recipients.size > 1 && `发给${entry.targetGroup?.name ?? `${name}本人`} · `}{entry.author.name} ·{' '}
            <time dateTime={entry.createdAt.toISOString()}>{displayDate(entry.createdAt)}</time>
          </p>
          {entry.version && assignment && <p className={styles.meta}>
            <Link href={resultHref(assignment.id, entry.version.id)} prefetch={false}>
              {entry.version.assignmentRevision?.title ?? assignment.title} · 当时的成果
            </Link>
          </p>}
        </li>;
      })}</ul>
    </details>}
    {showEmpty && !remarks.length && !hasClassroomNotes && !hasWork && !messages.length && <p className={styles.meta}>暂无记录。</p>}
    <div className={styles.oldDrafts}>
      <TeachingObservationForm {...oldDraft} legacyClassroomDraft/>
      <TeachingObservationForm {...oldDraft} feedback/>
      {history.results.map(result => {
        const version = { id: result.id, title: result.assignmentRevision?.title ?? result.submission.assignment.title };
        return <Fragment key={result.id}>
          <TeachingObservationForm {...oldDraft} version={version}
            sourcePageId={sourcePageId} sourcePageTitle={sourcePageTitle} sourceGroupId={sourceGroupId} sourceGroupName={sourceGroupName}/>
          <TeachingObservationForm {...oldDraft} version={version} feedback/>
        </Fragment>;
      })}
    </div>
  </>;
}
