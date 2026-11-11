import { compareSubmissionBodies } from '@/lib/submission-comparison';
import { formatTeachingDate } from '@/lib/teaching-format';
import styles from './submission-comparison.module.css';
import { SubmissionText } from './submission-text';

type VersionBody = { version: number; body: string };
type PreviousFeedback = { id: string; body: string; reviewer: { name: string }; createdAt: Date };

export function SubmissionComparison({ current, previous }: {
  current: VersionBody;
  previous: VersionBody & { feedback: readonly PreviousFeedback[] };
}) {
  const comparison = compareSubmissionBodies(previous.body, current.body);
  return <details className={styles.comparison}>
    <summary>对照第 {previous.version} 版与反馈</summary>
    {comparison.mode === 'identical' ? <p className={styles.note}>两版正文相同。</p> : <>
      <p className={styles.note}>{comparison.mode === 'range' ? '以下为两版中间部分的原文对照。' : '以下为有改动的句段。'}</p>
      {comparison.passages.map((passage, index) => <dl className={styles.pair} key={index}>
        <div>
          <dt>第 {previous.version} 版原文</dt>
          <dd>{passage.previous ? <SubmissionText text={passage.previous}/> : <span className={styles.empty}>此处无正文</span>}</dd>
        </div>
        <div>
          <dt>第 {current.version} 版原文</dt>
          <dd>{passage.current ? <SubmissionText text={passage.current}/> : <span className={styles.empty}>此处无正文</span>}</dd>
        </div>
      </dl>)}
    </>}
    <h4 className={styles.feedbackHeading}>第 {previous.version} 版的文字反馈</h4>
    {previous.feedback.length ? <ul className={styles.feedbackList}>
      {previous.feedback.map(feedback => <li key={feedback.id}>
        <div className={styles.byline}>{feedback.reviewer.name} · <time dateTime={feedback.createdAt.toISOString()}>{formatTeachingDate(feedback.createdAt)}</time></div>
        <p><SubmissionText text={feedback.body}/></p>
      </li>)}
    </ul> : <p className={styles.empty}>第 {previous.version} 版暂无文字反馈。</p>}
  </details>;
}
