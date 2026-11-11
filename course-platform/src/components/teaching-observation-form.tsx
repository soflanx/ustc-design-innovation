'use client';

import { useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { recordTeachingObservationAction, sendTeachingFeedbackAction } from '@/lib/teaching-observation-actions';
import { toTeachingDateInput } from '@/lib/teaching-format';
import { teachingRecordKindLabels, teachingRecordKinds, type TeachingRecordKind } from '@/lib/teaching-record-kind';
import { TeachingRecordsNoticeContext } from './teaching-records-notice';
import styles from './teaching-records.module.css';

type Draft = { body: string; context: string; date: string; kind?: TeachingRecordKind | ''; contextGroupId?: string; lessonTarget?: string; requestId: string | null };
const emptyDraft: Draft = { body: '', context: '', date: '', requestId: null };
type DraftSnapshot = { draft: Draft; storageFailed: boolean };
const emptySnapshot: DraftSnapshot = { draft: emptyDraft, storageFailed: false };
const drafts = new Map<string, DraftSnapshot>();

function getDraft(key: string): DraftSnapshot {
  const cached = drafts.get(key);
  if (cached) return cached;
  let snapshot = emptySnapshot;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) {
      const value: unknown = JSON.parse(raw);
      snapshot = isDraft(value) ? { draft: value, storageFailed: false } : { draft: emptyDraft, storageFailed: true };
    }
  } catch {
    snapshot = { draft: emptyDraft, storageFailed: true };
  }
  drafts.set(key, snapshot);
  return snapshot;
}

function isDraft(value: unknown): value is Draft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<Draft>;
  return typeof draft.body === 'string' && draft.body.length <= 12000
    && typeof draft.context === 'string' && draft.context.length <= 1000
    && typeof draft.date === 'string' && (!draft.date || /^\d{4,6}-\d{2}-\d{2}$/.test(draft.date))
    && (draft.kind === undefined || draft.kind === '' || teachingRecordKinds.some(kind => kind === draft.kind))
    && (draft.contextGroupId === undefined || (typeof draft.contextGroupId === 'string' && draft.contextGroupId.length <= 200))
    && (draft.lessonTarget === undefined || (typeof draft.lessonTarget === 'string' && draft.lessonTarget.length <= 207))
    && (draft.requestId === null || (typeof draft.requestId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(draft.requestId)));
}

function hasText(draft: Draft) {
  return !!(draft.body || draft.context || draft.date || draft.kind || draft.contextGroupId);
}

function putDraft(key: string, draft: Draft) {
  let storageFailed = false;
  try {
    if (hasText(draft) || draft.requestId) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
  } catch {
    storageFailed = true;
  }
  drafts.set(key, { draft, storageFailed });
  window.dispatchEvent(new Event(key));
}

export type TeachingSubject = { memberId: string } | { groupId: string };
export type TeachingGroupChoice = { id: string; name: string; current: boolean };
type LessonTargets = {
  students: { id: string; name: string; groupName?: string }[];
  groups: { id: string; name: string }[];
};

export function LegacyClassroomDrafts({ authorId, offeringId, pageId, lessonTargets }: {
  authorId: string; offeringId: string; pageId: string; lessonTargets?: LessonTargets;
}) {
  const [legacy, setLegacy] = useState<{ key: string; subject: TeachingSubject }[]>([]);
  useEffect(() => {
    const restored: typeof legacy = [];
    try {
      for (let index = 0; index < sessionStorage.length; index++) {
        const key = sessionStorage.key(index);
        if (!key?.startsWith('teaching-note:')) continue;
        let scope: unknown;
        try { scope = JSON.parse(key.slice('teaching-note:'.length)); }
        catch { continue; }
        if (!Array.isArray(scope) || scope[0] !== authorId || scope[1] !== offeringId || scope[3] !== null
          || scope[4] !== false || scope[5] !== pageId || scope[6] !== null || scope[7] !== 'classroom') continue;
        const target: unknown = scope[2];
        if (!target || typeof target !== 'object' || !hasText(getDraft(key).draft)) continue;
        if ('memberId' in target && typeof target.memberId === 'string') restored.push({ key, subject: { memberId: target.memberId } });
        else if ('groupId' in target && typeof target.groupId === 'string') restored.push({ key, subject: { groupId: target.groupId } });
      }
    } catch { /* Old drafts are only recoverable from available session storage. */ }
    setLegacy(restored);
  }, [authorId, offeringId, pageId]);

  return legacy.map(({ key, subject }) => {
    const name = 'memberId' in subject ? lessonTargets?.students.find(item => item.id === subject.memberId)?.name
      : lessonTargets?.groups.find(item => item.id === subject.groupId)?.name;
    return <TeachingObservationForm key={key} authorId={authorId} offeringId={offeringId} subject={subject}
      subjectName={name ?? '原关联对象'} sourcePageId={pageId} draftOnly legacyClassroomDraft
      summaryLabel={name ? `查看${name}的旧草稿` : '查看未保存的旧课堂草稿'}/>;
  });
}

export function TeachingObservationForm({
  offeringId, authorId, subject, subjectName, version, feedback = false, archived = false,
  sourcePageId, sourcePageTitle, sourceGroupId, sourceGroupName, groupChoices, lessonTargets, summaryLabel,
  draftOnly = false, legacyClassroomDraft = false, simpleNote = false,
}: {
  offeringId: string; authorId: string; subject: TeachingSubject | { pageId: string }; subjectName: string;
  version?: { id: string; title: string }; feedback?: boolean; archived?: boolean;
  sourcePageId?: string; sourcePageTitle?: string; sourceGroupId?: string; sourceGroupName?: string;
  groupChoices?: TeachingGroupChoice[];
  lessonTargets?: LessonTargets; summaryLabel?: string; draftOnly?: boolean; legacyClassroomDraft?: boolean;
  simpleNote?: boolean;
}) {
  const field = useId();
  const router = useRouter();
  const showNotice = useContext(TeachingRecordsNoticeContext);
  const isLesson = 'pageId' in subject;
  const isStudent = 'memberId' in subject;
  const fixedGroupId = isStudent ? sourceGroupId : undefined;
  const scope = [authorId, offeringId, subject, version?.id, feedback];
  if (simpleNote) scope.push('standalone-note');
  // Keep existing context-free drafts and all feedback drafts reachable at their original keys.
  if (!feedback && (sourcePageId || fixedGroupId || legacyClassroomDraft)) scope.push(sourcePageId, fixedGroupId);
  if (legacyClassroomDraft) scope.push('classroom');
  const key = `teaching-note:${JSON.stringify(scope)}`;
  const subscribe = useCallback((notify: () => void) => {
    window.addEventListener(key, notify);
    return () => window.removeEventListener(key, notify);
  }, [key]);
  const { draft, storageFailed } = useSyncExternalStore(subscribe, () => getDraft(key), () => emptySnapshot);
  const { body, context, date, kind = '' } = draft;
  const setField = <K extends 'body' | 'context' | 'date' | 'kind' | 'contextGroupId' | 'lessonTarget',>(name: K, value: Draft[K]) =>
    putDraft(key, { ...getDraft(key).draft, [name]: value, requestId: null });
  const working = useRef(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ success?: string; error?: string }>({});
  const audience = isStudent ? '学生' : '小组';
  const confirmedLeave = !simpleNote && !feedback && kind === 'LEAVE_CONFIRMED';
  const selectedGroup = groupChoices?.find(group => group.id === draft.contextGroupId);
  const missingGroup = Boolean(draft.contextGroupId && groupChoices && !selectedGroup);
  const selectedLessonStudent = lessonTargets?.students.find(item => `member:${item.id}` === draft.lessonTarget);
  const selectedLessonGroup = lessonTargets?.groups.find(item => `group:${item.id}` === draft.lessonTarget);
  const missingLessonTarget = Boolean(isLesson && draft.lessonTarget && !selectedLessonStudent && !selectedLessonGroup);
  const showScope = !simpleNote && !isLesson && !feedback && (sourcePageId || fixedGroupId);
  const today = toTeachingDateInput(new Date()).slice(0, 10);
  const futureDraftDate = !simpleNote && !feedback && (date.length > today.length || date > today);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (archived || draftOnly || working.current || missingGroup || missingLessonTarget || futureDraftDate) return;
    working.current = true;
    setPending(true);
    setMessage({});
    try {
      const current = getDraft(key).draft;
      const sent = { ...current, requestId: current.requestId ?? crypto.randomUUID() };
      putDraft(key, sent);
      const input = {
        targetMemberId: 'memberId' in subject ? subject.memberId : selectedLessonStudent?.id ?? null,
        targetGroupId: 'groupId' in subject ? subject.groupId : selectedLessonGroup?.id ?? null,
        versionId: version?.id ?? null,
        body: sent.body, context: simpleNote ? '' : sent.context, requestId: sent.requestId,
      };
      const result = feedback
        ? await sendTeachingFeedbackAction(offeringId, authorId, input)
        : await recordTeachingObservationAction(offeringId, authorId, {
          ...input,
          pageId: simpleNote ? null : 'pageId' in subject ? subject.pageId : sourcePageId ?? null,
          contextGroupId: simpleNote ? null : fixedGroupId || (groupChoices ? sent.contextGroupId || null : null),
          kind: simpleNote ? null : sent.kind || null,
          observedAt: !simpleNote && sent.date ? new Date(`${sent.date}T00:00:00+08:00`).toISOString() : null,
        });
      if (!isLesson || !showNotice || !result.success) setMessage(result);
      if (result.success) {
        if (getDraft(key).draft === sent) putDraft(key, emptyDraft);
        if (simpleNote) {
          setMessage({ success: '备注已保存。' });
          setOpen(false);
        }
        const recordId = 'recordId' in result && typeof result.recordId === 'string' ? result.recordId : undefined;
        if (isLesson) showNotice?.({ message: '记录已保存。', recordHref: recordId ? `#record-${encodeURIComponent(recordId)}` : undefined });
        router.refresh();
      }
    } catch {
      setMessage({ error: '暂未确认保存结果。文字仍在，可直接重试。' });
    } finally {
      working.current = false;
      setPending(false);
    }
  }

  if (archived || draftOnly) {
    const text = [
      kind && teachingRecordKindLabels[kind], body, context && `情境或来源：${context}`, date && `发生日期：${date}`,
    ].filter(Boolean).join('\n\n');
    if (!text.trim()) return null;
    return <details>
      <summary>{draftOnly ? summaryLabel ?? (feedback ? '查看未发送的旧留言草稿' : '查看未保存的旧记录草稿')
        : feedback ? '查看未发送的反馈草稿' : '查看未保存的观察草稿'}</summary>
      <div className="stack">
        <p className="field-help">{archived ? '课程已归档。' : '这是旧入口留下的草稿。'}草稿只在当前标签页可查看和复制。{version && ` 对应成果：${version.title}。`}</p>
        {storageFailed && <p className="notice" role="status">草稿仍在当前页面，刷新后可能无法恢复。</p>}
        <label htmlFor={field}>草稿内容</label>
        <textarea id={field} rows={5} value={text} readOnly/>
        <div className={styles.actions}><button type="button" className="button secondary" onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setMessage({ success: '草稿已复制。' });
          } catch {
            const fieldElement = document.getElementById(field) as HTMLTextAreaElement | null;
            fieldElement?.focus();
            fieldElement?.select();
            setMessage({ error: '已选中草稿，请手动复制。' });
          }
        }}>复制草稿</button>
          {draftOnly && <button type="button" className="button" onClick={() => {
            try {
              sessionStorage.removeItem(key);
              drafts.delete(key);
              window.dispatchEvent(new Event(key));
            } catch {
              setMessage({ error: '当前无法清除这份旧草稿。' });
            }
          }}>清除旧草稿</button>}
        </div>
        {message.error && <p className="notice" role="status">{message.error}</p>}
        {message.success && <p className="notice" role="status">{message.success}</p>}
      </div>
    </details>;
  }

  const form = <form onSubmit={submit} className={styles.noteForm}>
      {showScope && <dl id={`${field}-scope`} className={styles.scope}>
        <div><dt>对象</dt><dd>{subjectName}</dd></div>
        <div><dt>课次</dt><dd>{sourcePageTitle ?? (sourcePageId ? '当前课次' : '未关联课次')}</dd></div>
        {(fixedGroupId || selectedGroup) && <div><dt>小组情境</dt><dd>{sourceGroupName ?? selectedGroup?.name ?? '当前小组'}</dd></div>}
      </dl>}
      <p id={`${field}-visibility`} className={styles.meta}>{feedback ? isStudent ? `仅发给 ${subjectName} 本人。` : `发给 ${subjectName} 的组员。以后加入本组的学生也可查看。` : '仅本期教师和助教可见。'}{version && ` 对应成果：${version.title}。`}</p>
      <div className="form-field">
        <label htmlFor={field}>{feedback ? '反馈内容' : simpleNote ? isStudent ? '个人备注' : '小组备注' : isLesson ? '记录正文' : '观察内容'}</label>
        <textarea id={field} required maxLength={12000} rows={isLesson ? 3 : 4} readOnly={pending} autoFocus={isLesson} value={body}
          aria-describedby={showScope ? `${field}-scope ${field}-visibility` : `${field}-visibility`} onChange={event => { setField('body', event.target.value); }}/>
      </div>
      {isLesson && lessonTargets && (lessonTargets.students.length > 0 || lessonTargets.groups.length > 0 || missingLessonTarget) && <div className="form-field">
        <label htmlFor={`${field}-target`}>关联学生或小组（选填）</label>
        <select id={`${field}-target`} value={draft.lessonTarget ?? ''} disabled={pending} onChange={event => setField('lessonTarget', event.target.value)}>
          <option value="">整堂课</option>
          {missingLessonTarget && <option value={draft.lessonTarget} disabled>草稿原关联对象已不可用</option>}
          {lessonTargets.students.length > 0 && <optgroup label="学生">
            {lessonTargets.students.map(item => <option key={item.id} value={`member:${item.id}`}>{item.name} · {item.groupName ?? '未分组'}</option>)}
          </optgroup>}
          {lessonTargets.groups.length > 0 && <optgroup label="小组">
            {lessonTargets.groups.map(item => <option key={item.id} value={`group:${item.id}`}>{item.name}</option>)}
          </optgroup>}
        </select>
      </div>}
      {!isLesson && !simpleNote && <details>
        <summary className={styles.disclosure}>{feedback ? '补充情境' : groupChoices?.length ? '补充类型、情境或日期' : '补充类型、来源或日期'}{kind && ` · ${teachingRecordKindLabels[kind]}`}</summary>
        <div className="form-field">
          {!feedback && <>
            <label htmlFor={`${field}-kind`}>记录类型（选填）</label>
            <select id={`${field}-kind`} value={kind} disabled={pending} onChange={event => {
              const value = teachingRecordKinds.find(item => item === event.target.value);
              setField('kind', value ?? '');
            }}>
              <option value="">不指定类型</option>
              {teachingRecordKinds.filter(item => isStudent || (item !== 'LEAVE_REPORTED' && item !== 'LEAVE_CONFIRMED')).map(item =>
                <option key={item} value={item}>{teachingRecordKindLabels[item]}</option>
              )}
            </select>
          </>}
          {!confirmedLeave && <>
            <label htmlFor={`${field}-context`}>情境或来源（选填）</label>
            <input id={`${field}-context`} value={context} maxLength={1000} readOnly={pending} onChange={event => { setField('context', event.target.value); }}/>
          </>}
          {!fixedGroupId && groupChoices && (groupChoices.length > 0 || missingGroup) && <>
            <label htmlFor={`${field}-group`}>关联小组情境（选填）</label>
            <select id={`${field}-group`} value={draft.contextGroupId ?? ''} disabled={pending} onChange={event => { setField('contextGroupId', event.target.value); }}>
              <option value="">不关联小组</option>
              {missingGroup && <option value={draft.contextGroupId} disabled>草稿原小组已不可用</option>}
              {groupChoices.map(group => <option key={group.id} value={group.id}>{group.name}{group.current ? '（当前小组）' : '（曾加入）'}</option>)}
            </select>
          </>}
          {!feedback && <>
            <label htmlFor={`${field}-date`}>实际发生日期（选填）</label>
            <input id={`${field}-date`} type="date" max={today} value={date} readOnly={pending} onChange={event => { setField('date', event.target.value); }}/>
          </>}
      </div></details>}
      {confirmedLeave && <div className="form-field">
        <label htmlFor={`${field}-context`}>请假确认来源（必填）</label>
        <input id={`${field}-context`} value={context} maxLength={1000} readOnly={pending} required onChange={event => { setField('context', event.target.value); }} aria-describedby={`${field}-leave-help`}/>
        <p id={`${field}-leave-help`} className={styles.meta}>用于记录已经确认的结果。请写明确认人或已有消息。</p>
      </div>}
      {missingGroup && <p className="notice error" role="alert">草稿原来关联的小组已不可用。请重新选择小组或取消关联。</p>}
      {missingLessonTarget && <p className="notice error" role="alert">草稿原来关联的对象已不可用。请选择整堂课或其他对象。</p>}
      {futureDraftDate && <p className="notice error" role="alert">草稿的发生日期晚于北京时间今天。请展开补充选项，修改或清空日期。</p>}
      {storageFailed && <p className="notice" role="status">{hasText(draft)
        ? '草稿仍在当前页面，刷新后可能无法恢复。'
        : '无法核对标签页中的草稿。刷新后如有旧稿，请先查看已保存的记录。'}</p>}
      {message.error && <p className="notice error" role="alert">{message.error}</p>}
      {!simpleNote && message.success && <p className="notice" role="status">{message.success}</p>}
      <div className={styles.actions}>
        <button className="button primary" type="submit" disabled={pending || missingGroup || missingLessonTarget || futureDraftDate}>{pending ? '正在保存…' : feedback ? '发送反馈' : simpleNote ? '保存备注' : isLesson ? '保存记录' : '保存内部观察'}</button>
      </div>
    </form>;
  return <>{simpleNote && message.success && <p className="notice" role="status">{message.success}</p>}
  <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={summaryLabel ? styles.disclosure : undefined}>{summaryLabel ?? (feedback ? `给${audience}反馈` : '记录内部观察')}</summary>
    {(!isLesson || open) && form}
  </details></>;
}
