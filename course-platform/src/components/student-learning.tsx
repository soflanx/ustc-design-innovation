import Link from 'next/link';
import type { StudentLearning, StudentLearningGuidance, StudentLearningResult, StudentLearningVersion } from '@/lib/student-learning';
import { formatTeachingDate } from '@/lib/teaching-format';
import { SubmissionText } from './submission-text';
import styles from './student-learning.module.css';

function SubmissionMetadata({ version, context }: { version: StudentLearningVersion; context?: string }) {
  return <p className={styles.meta}>
    {context && `${context} · `}{version.submittedBy.name} 提交 · <time dateTime={version.submittedAt.toISOString()}>{formatTeachingDate(version.submittedAt)}</time>
  </p>;
}

function ResultRecord({ result }: { result: StudentLearningResult }) {
  const [latest, ...earlier] = result.versions;
  if (!latest) return null;
  const owner = result.mode === 'INDIVIDUAL' ? '个人提交' : result.groupName ? `随${result.groupName}交付` : '小组交付';
  const status = result.status === 'CANCELLED' ? ' · 作业已取消' : result.status === 'ARCHIVED' ? ' · 作业已结束' : '';
  return <li id={`result-${result.submissionId}`} className={styles.record} data-learning-result={result.submissionId}>
    <h3><Link href={latest.href}>{result.title}</Link></h3>
    <SubmissionMetadata version={latest} context={`${owner}${status}`}/>
    {earlier.length > 0 && <details className={styles.disclosure}>
      <summary>此前参与的版本（{earlier.length}）</summary>
      <ul className={styles.previousVersions}>{earlier.map(version => <li key={version.id}>
        <Link href={version.href}>第 {version.version} 次提交</Link>
        <SubmissionMetadata version={version}/>
      </li>)}</ul>
    </details>}
  </li>;
}

function SavedMessage({ item }: { item: StudentLearningGuidance }) {
  const recipient = item.recipientBasis === 'PERSONAL' ? '发给我' : `当时发给${item.groupName ?? '所在小组'}`;
  return <li id={`guidance-${item.id}`} className={styles.record} data-learning-guidance={item.id}>
    {item.result && <h3><Link href={item.result.href}>{item.result.title}</Link></h3>}
    {item.context && <p className={styles.messageBody}>{item.context}</p>}
    <p className={styles.messageBody}><SubmissionText text={item.body}/></p>
    <p className={styles.meta}>{recipient} · {item.author.name} · <time dateTime={item.createdAt.toISOString()}>{formatTeachingDate(item.createdAt)}</time></p>
  </li>;
}

export function StudentLearningView({ data }: { data: StudentLearning }) {
  const base = `/courses/${encodeURIComponent(data.offering.id)}`;
  const archived = data.offering.status === 'ARCHIVED';
  const results = data.participatedResults.filter(result => result.versions.length > 0);
  const guidance = data.guidance.filter(item => item.recipientBasis === 'PERSONAL' || item.recipientBasis === 'RECEIVED_GROUP');
  const records = [
    ...results.map(result => ({ key: result.submissionId, date: result.versions[0].submittedAt, content: <ResultRecord key={result.submissionId} result={result}/> })),
    ...guidance.map(item => ({ key: item.id, date: item.createdAt, content: <SavedMessage key={item.id} item={item}/> })),
  ].sort((a, b) => b.date.getTime() - a.date.getTime() || a.key.localeCompare(b.key));
  return <div className={styles.page}>
    <header className={styles.heading}>
      <Link className="breadcrumb" href={base}>← 课程首页</Link>
      <h1>本学期记录</h1>
      {archived && <p className={styles.notice}>本学期已归档，作品和已有评语保留供回顾。</p>}
    </header>

    <div id="records" className={styles.records}>
      {records.length ? <ul className={styles.list}>{records.map(record => record.content)}</ul>
        : <p className={styles.empty}>暂无记录。</p>}
      {data.groupHistory.length > 0 && <details className={styles.groupHistory}>
        <summary>本期小组经历</summary>
        <ul>{data.groupHistory.map(group => <li key={group.id}>
          <strong>{group.groupName}</strong><span>{formatTeachingDate(group.joinedAt)} 加入{group.leftAt ? ` · ${formatTeachingDate(group.leftAt)} 离组` : archived ? ' · 学期结束时所在小组' : ' · 在组'}</span>
        </li>)}</ul>
      </details>}
    </div>
  </div>;
}
