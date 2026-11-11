'use client';

import { useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { recordLessonStudentEventsAction } from '@/lib/teaching-observation-actions';
import { lessonStudentEventKinds, type LessonStudentEventKind } from '@/lib/teaching-record-kind';
import { TeachingRecordsNoticeContext } from './teaching-records-notice';
import styles from './lesson-student-record-form.module.css';

type Student = { id: string; name: string; groupName?: string };
type Draft = { kind: LessonStudentEventKind | ''; memberIds: string[]; studentSnapshots?: Student[]; body: string; requestId: string | null };
type Snapshot = { draft: Draft; storageFailed: boolean };
const maxStudents = 200;
const emptyDraft: Draft = { kind: '', memberIds: [], body: '', requestId: null };
const emptySnapshot: Snapshot = { draft: emptyDraft, storageFailed: false };
const drafts = new Map<string, Snapshot>();
const labels: Record<LessonStudentEventKind, string> = {
  LEAVE_REPORTED: '请假', ABSENT: '未到', PARTICIPATION: '课堂发言',
};

function isStudentSnapshot(value: unknown): value is Student {
  if (!value || typeof value !== 'object') return false;
  const student = value as Partial<Student>;
  return typeof student.id === 'string' && typeof student.name === 'string'
    && (student.groupName === undefined || typeof student.groupName === 'string');
}

function isDraft(value: unknown): value is Draft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<Draft>;
  return (draft.kind === '' || lessonStudentEventKinds.some(kind => kind === draft.kind))
    && Array.isArray(draft.memberIds) && draft.memberIds.length <= maxStudents
    && draft.memberIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)
    && new Set(draft.memberIds).size === draft.memberIds.length
    && (draft.studentSnapshots === undefined || (Array.isArray(draft.studentSnapshots)
      && draft.studentSnapshots.length <= maxStudents && draft.studentSnapshots.every(isStudentSnapshot)))
    && typeof draft.body === 'string' && draft.body.length <= 12000
    && (draft.requestId === null || (typeof draft.requestId === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(draft.requestId)));
}

function hasDraft(draft: Draft) {
  return !!(draft.kind || draft.memberIds.length || draft.body || draft.requestId);
}

function getDraft(key: string): Snapshot {
  const cached = drafts.get(key);
  if (cached) return cached;
  let snapshot = emptySnapshot;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) {
      const draft: unknown = JSON.parse(raw);
      snapshot = isDraft(draft) ? { draft, storageFailed: false } : { draft: emptyDraft, storageFailed: true };
    }
  } catch {
    snapshot = { draft: emptyDraft, storageFailed: true };
  }
  drafts.set(key, snapshot);
  return snapshot;
}

function putDraft(key: string, draft: Draft) {
  let storageFailed = false;
  try {
    if (hasDraft(draft)) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
  } catch {
    storageFailed = true;
  }
  drafts.set(key, { draft, storageFailed });
  window.dispatchEvent(new Event(key));
}

function studentLabel(student: Student) {
  return student.name + ' · ' + (student.groupName ?? '未分组');
}

export function LessonStudentRecordForm({ authorId, offeringId, pageId, students, archived }: {
  authorId: string;
  offeringId: string;
  pageId: string;
  students: Student[];
  archived: boolean;
}) {
  const field = useId();
  const router = useRouter();
  const showNotice = useContext(TeachingRecordsNoticeContext);
  const key = 'lesson-student-events:' + JSON.stringify([authorId, offeringId, pageId]);
  const subscribe = useCallback((notify: () => void) => {
    window.addEventListener(key, notify);
    return () => window.removeEventListener(key, notify);
  }, [key]);
  const { draft, storageFailed } = useSyncExternalStore(subscribe, () => getDraft(key), () => emptySnapshot);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const working = useRef(false);
  const summary = useRef<HTMLElement>(null);
  const copyField = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (hasDraft(getDraft(key).draft)) setOpen(true);
  }, [key]);

  const byId = new Map(students.map(student => [student.id, student]));
  const chosen = new Set(draft.memberIds);
  const missingStudent = draft.memberIds.some(id => !byId.has(id));
  const checkingPreviousSave = missingStudent && draft.requestId !== null;
  const selectedLabels = draft.memberIds.map((id, index) => {
    const student = draft.studentSnapshots?.find(item => item.id === id) ?? byId.get(id);
    if (!student) return '已不可选的学生 ' + (index + 1);
    return studentLabel(student) + (byId.has(id) ? '' : ' · 已不可选');
  });
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const results = students.filter(student => terms.every(term => studentLabel(student).toLocaleLowerCase().includes(term)));

  function change(patch: Partial<Pick<Draft, 'kind' | 'memberIds' | 'studentSnapshots' | 'body'>>) {
    putDraft(key, { ...getDraft(key).draft, ...patch, requestId: null });
    setError('');
  }

  function toggle(studentId: string, selected: boolean) {
    const current = getDraft(key).draft;
    const student = byId.get(studentId);
    if (selected === current.memberIds.includes(studentId) || (selected && !student)) return;
    if (selected && current.memberIds.length >= maxStudents) {
      setError('每次最多选择 200 位学生。');
      return;
    }
    const memberIds = selected ? [...current.memberIds, studentId] : current.memberIds.filter(id => id !== studentId);
    change({ memberIds, studentSnapshots: captureStudents(current, memberIds) });
  }

  function captureStudents(current: Draft, memberIds = current.memberIds) {
    return memberIds.flatMap(id => {
      const student = current.studentSnapshots?.find(item => item.id === id) ?? byId.get(id);
      return student ? [student] : [];
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (archived || working.current) return;
    const current = getDraft(key).draft;
    if (!current.kind) { setError('请选择要记录的情况。'); return; }
    if (!current.memberIds.length) { setError('请至少选择一位学生。'); return; }
    if (!current.requestId && current.memberIds.some(id => !byId.has(id))) { setError('请先移除不可选的学生。'); return; }
    if (current.kind === 'PARTICIPATION' && !current.body.trim()) { setError('请填写课堂发言内容。'); return; }

    working.current = true;
    setPending(true);
    setError('');
    try {
      const requestId = current.requestId ?? crypto.randomUUID();
      const sent = { ...current, requestId, studentSnapshots: captureStudents(current) };
      putDraft(key, sent);
      const result = await recordLessonStudentEventsAction(offeringId, authorId, {
        pageId, kind: current.kind, memberIds: sent.memberIds, body: sent.body.trim(), requestId,
      });
      if (result.error || !result.records?.length) {
        setError(result.error ?? '暂未确认保存结果，可直接重试。');
        setOpen(true);
        return;
      }

      if (getDraft(key).draft === sent) putDraft(key, emptyDraft);
      const first = result.records.find(record => record.memberId === sent.memberIds[0]) ?? result.records[0];
      showNotice?.({ message: result.success ?? '学生情况已保存。', recordHref: '#record-' + encodeURIComponent(first.recordId) });
      setQuery('');
      setOpen(false);
      summary.current?.focus({ preventScroll: true });
      router.refresh();
    } catch {
      setError('暂未确认保存结果。所选学生和说明仍在，可直接重试。');
      setOpen(true);
    } finally {
      working.current = false;
      setPending(false);
    }
  }

  if (archived) {
    if (!hasDraft(draft)) return null;
    const text = [draft.kind && labels[draft.kind], selectedLabels.join('、'), draft.body].filter(Boolean).join('\n');
    return <details className={styles.entry}>
      <summary className={styles.summary}>查看未保存的学生情况</summary>
      <div className={styles.form}>
        <p className={styles.help}>课程已归档。这份草稿仅在当前标签页可查看和复制。</p>
        <label className={styles.field}>草稿内容<textarea ref={copyField} rows={4} value={text} readOnly/></label>
        <div><button className="button secondary" type="button" onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopyStatus('草稿已复制。');
          } catch {
            copyField.current?.focus();
            copyField.current?.select();
            setCopyStatus('已选中草稿，请手动复制。');
          }
        }}>复制草稿</button></div>
        {copyStatus && <p role="status" className={styles.help}>{copyStatus}</p>}
      </div>
    </details>;
  }

  return <details className={styles.entry} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={styles.summary} ref={summary}>记学生情况</summary>
    {open && <form className={styles.form} onSubmit={save} aria-label="记学生情况" aria-busy={pending}>
      <p className={styles.help}>只为所选学生保存本课记录。仅本期教师和助教可见。</p>
      <fieldset className={styles.kinds} disabled={pending}>
        <legend>记录什么</legend>
        <div>{lessonStudentEventKinds.map(kind => <label key={kind}>
          <input type="radio" name={field + '-kind'} value={kind} checked={draft.kind === kind} onChange={() => change({ kind })}/>
          {labels[kind]}
        </label>)}</div>
        {draft.kind === 'LEAVE_REPORTED' && <p className={styles.help}>记录收到的请假消息。</p>}
      </fieldset>
      <div className={styles.students}>
        <label className={styles.field}>搜索学生
          <input type="search" placeholder="姓名或组名" value={query} disabled={pending} onChange={event => setQuery(event.currentTarget.value)}/>
        </label>
        {draft.memberIds.length > 0 && <div className={styles.selected}>
          <p>已选 {draft.memberIds.length} 人</p>
          <ul aria-label="已选学生">{draft.memberIds.map((id, index) => {
            const name = selectedLabels[index];
            return <li key={id}><button type="button" disabled={pending} onClick={() => toggle(id, false)} aria-label={'移除 ' + name}>
              {name} <span aria-hidden="true">×</span>
            </button></li>;
          })}</ul>
          {missingStudent && <p className={styles.help}>{checkingPreviousSave
            ? '名单已有变化。可按原名单重试，核对上次是否保存。'
            : '原草稿有学生已不可选，请先移除。'}</p>}
        </div>}
        {results.length ? <ul className={styles.roster} aria-label="可选学生">
          {results.map(student => <li key={student.id}><label>
            <input type="checkbox" checked={chosen.has(student.id)} disabled={pending} onChange={event => toggle(student.id, event.currentTarget.checked)}/>
            <span>{student.name}</span> <small>{student.groupName ?? '未分组'}</small>
          </label></li>)}
        </ul> : <p className={styles.help}>{query.trim() ? '没有匹配的学生。' : '本期暂无可选学生。'}</p>}
      </div>
      <label className={styles.field}>{draft.kind === 'PARTICIPATION' ? '发言内容（必填）' : '补充说明（选填）'}
        <textarea rows={3} maxLength={12000} required={draft.kind === 'PARTICIPATION'} readOnly={pending} value={draft.body}
          onChange={event => change({ body: event.currentTarget.value })}/>
      </label>
      {storageFailed && <p className={styles.help} role="status">当前标签页暂时无法保存草稿，刷新后可能无法恢复。</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <div><button className="button primary" type="submit" disabled={pending || (!draft.requestId && (missingStudent || !students.length))}>
        {pending ? '正在保存…' : checkingPreviousSave ? '核对上次保存' : '保存学生情况'}
      </button></div>
    </form>}
  </details>;
}
