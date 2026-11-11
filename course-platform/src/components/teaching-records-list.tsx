import Link from 'next/link';
import { groupWorkHref } from '@/lib/group-work-link';
import { displayDate } from '@/lib/policy';
import { formatTeachingDate } from '@/lib/teaching-format';
import type { getTeachingObservations } from '@/lib/teaching-observations';
import { teachingRecordKindLabels } from '@/lib/teaching-record-kind';
import { TeachingRecordsAmendment } from './teaching-records-amendment';
import { TeachingRecordsNotice } from './teaching-records-notice';
import styles from './teaching-records.module.css';

type Note = Awaited<ReturnType<typeof getTeachingObservations>>['observations'][number];

const historyLabels = { RECORDED: '原始记录', CORRECTED: '更正', WITHDRAWN: '撤回' };
const historyActors = { RECORDED: '记录人', CORRECTED: '更正人', WITHDRAWN: '撤回人' };

function SavedTime({ value }: { value: Date }) {
  return <time dateTime={value.toISOString()}>{formatTeachingDate(value)}</time>;
}

export function TeachingRecordsList({
  offeringId, authorId, notes, resultHref, lessonHref, contextGroupHref, historyContext, historyPlacement, withdrawnHistoryHref,
}: {
  offeringId: string;
  authorId: string;
  notes: Note[];
  resultHref?: (assignmentId: string, versionId: string) => string;
  lessonHref?: (pageId: string) => string;
  contextGroupHref?: (groupId: string) => string;
  historyContext?: 'member' | 'group' | 'lesson';
  historyPlacement?: 'result' | 'lesson' | 'standalone';
  withdrawnHistoryHref?: string;
}) {
  const base = `/courses/${encodeURIComponent(offeringId)}`;
  const inLesson = historyContext === 'lesson';
  const compact = historyContext === 'member' || historyContext === 'group';

  const records = notes.length ? <ul className={compact ? `${styles.recordList} ${styles.compactRecordList}` : styles.recordList}>{notes.map(note => {
    const subjectName = note.targetMember?.user.name ?? note.targetGroup?.name ?? '整堂课';
    const groupMember = historyContext === 'group' ? note.targetMember : null;
    const showSubject = !historyContext || inLesson || !!groupMember;
    const contextGroup = historyContext === 'group' ? null : note.contextGroup;
    const contextLabel = note.kind === 'LEAVE_CONFIRMED' ? '请假确认来源' : '情境或来源';
    const origin = new URLSearchParams();
    if ((groupMember || inLesson) && note.page) origin.set('fromPage', note.page.id);
    if (inLesson) origin.set('fromLessonRecords', '1');
    if (note.contextGroup) origin.set('fromGroup', note.contextGroup.id);
    const memberHref = (inLesson || groupMember) && note.targetMember
      ? `${base}/members/${encodeURIComponent(note.targetMember.id)}?${origin}`
      : null;
    const groupHref = (groupId: string) => {
      const href = groupWorkHref(offeringId, note.page?.id, groupId);
      return inLesson && href.includes('?') ? `${href}&fromLessonRecords=1` : href;
    };
    const versionParams = new URLSearchParams(inLesson ? { fromLessonRecords: '1' } : origin);
    if (!inLesson && note.targetGroup) versionParams.set('fromGroup', note.targetGroup.id);
    if (!inLesson && note.targetMember) versionParams.set('fromMember', note.targetMember.id);
    if (note.page) versionParams.set('fromPage', note.page.id);
    const assignment = note.version?.submission.assignment;
    const versionHref = historyPlacement !== 'result' && note.version && assignment && (resultHref
      ? resultHref(assignment.id, note.version.id)
      : `${base}/assignments/${encodeURIComponent(assignment.id)}/submissions/${encodeURIComponent(note.version.id)}${versionParams.size ? `?${versionParams}` : ''}`);
    const pageHref = note.page && (!historyContext || historyPlacement === 'result')
      ? lessonHref?.(note.page.id) ?? `${base}/pages/${encodeURIComponent(note.page.id)}` : null;
    const historyHref = withdrawnHistoryHref ?? (note.page ? `${base}/pages/${encodeURIComponent(note.page.id)}?view=records&includeWithdrawn=1` : undefined);
    const actualDate = note.observedAt && <time dateTime={note.observedAt.toISOString()}>{displayDate(note.observedAt)}</time>;
    const authorMeta = <p className={styles.meta}>记录人 {note.author.name} · 保存于 <SavedTime value={note.createdAt}/>
      {historyContext && actualDate && <> · 发生于 {actualDate}</>}</p>;
    const shortMeta = <p className={styles.meta}>{note.author.name} · {actualDate ? <>发生于 {actualDate}</>
      : <>记录于 <time dateTime={note.createdAt.toISOString()}>{displayDate(note.createdAt)}</time></>}</p>;
    const bodyRepeatsKind = (note.kind === 'ABSENT' || note.kind === 'LEAVE_REPORTED')
      && note.body === teachingRecordKindLabels[note.kind];
    return <li key={note.id} id={`record-${note.id}`} className={styles.record}>
      {(showSubject || note.kind || note.withdrawn) && <p className={styles.recordHeading}>
        {showSubject && <strong>{groupMember && '个人 · '}{memberHref ? <Link href={memberHref} prefetch={false}>{subjectName}</Link>
          : inLesson && note.targetGroup ? <Link href={groupHref(note.targetGroup.id)} prefetch={false}>{subjectName}</Link> : subjectName}</strong>}
        {note.kind && <>{showSubject && ' · '}{teachingRecordKindLabels[note.kind]}</>}
        {note.withdrawn && <>{(showSubject || note.kind) && ' · '}已撤回</>}
      </p>}
      {(pageHref || !historyContext || contextGroup || versionHref) && <div className={styles.recordContext}>
        {pageHref && note.page && <span>课次 <Link href={pageHref} prefetch={false}>{note.page.title}</Link></span>}
        {!historyContext && !note.page && <span>未关联课次</span>}
        {contextGroup && <span>小组情境 <Link href={contextGroupHref?.(contextGroup.id) ?? groupHref(contextGroup.id)} prefetch={false}>{contextGroup.name}</Link></span>}
        {versionHref && <Link href={versionHref} prefetch={false}>{note.version?.assignmentRevision?.title ?? assignment?.title} · 当时的成果</Link>}
      </div>}
      {!historyContext && authorMeta}
      {!note.withdrawn && <>
        {!historyContext && actualDate && <p className={styles.meta}>实际发生日期 {actualDate}</p>}
        {!bodyRepeatsKind && <p className={styles.recordBody}>{note.body}</p>}
      </>}
      {historyContext && shortMeta}
      <details className={styles.recordDetails}>
        <summary className={styles.disclosure}>记录详情{note.withdrawn ? ' · 已撤回' : note.revision > 0 ? ' · 已更正' : ''}</summary>
        {historyContext && authorMeta}
        {!note.withdrawn && note.context && <p className={styles.meta}>{contextLabel} · {note.context}</p>}
        {note.revision > 0 && <details>
        <summary className={styles.disclosure}>查看更正与撤回历史</summary>
        <ol className={styles.history}>{note.history.map(entry => <li key={entry.revision}>
          <p className={styles.meta}>{historyLabels[entry.action]} · {historyActors[entry.action]} {entry.author.name} · <SavedTime value={entry.createdAt}/></p>
          {entry.body && <p className={styles.recordBody}>{entry.body}</p>}
          {entry.context && <p className={styles.meta}>{contextLabel} · {entry.context}</p>}
          {entry.observedAt && <p className={styles.meta}>实际发生日期 <time dateTime={entry.observedAt.toISOString()}>{displayDate(entry.observedAt)}</time></p>}
          {entry.reason && <p className={styles.meta}>{entry.action === 'WITHDRAWN' ? '撤回原因' : '更正说明'} · {entry.reason}</p>}
        </li>)}</ol>
        </details>}
      {(note.canAmend || note.canWithdraw) && <TeachingRecordsAmendment
        offeringId={offeringId}
        authorId={authorId}
        record={{ id: note.id, revision: note.revision, body: note.body, context: note.context, observedAt: note.observedAt?.toISOString() ?? null }}
        confirmedLeave={note.kind === 'LEAVE_CONFIRMED'}
        canCorrect={note.canAmend}
        canWithdraw={note.canWithdraw}
        historyHref={historyHref ? `${historyHref}#record-${encodeURIComponent(note.id)}` : undefined}
      />}
      </details>
    </li>;
  })}</ul> : <p className={styles.meta}>暂无已保存记录。</p>;

  return inLesson ? records : <TeachingRecordsNotice key={JSON.stringify([offeringId, authorId])}>{records}</TeachingRecordsNotice>;
}
