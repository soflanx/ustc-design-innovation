'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { FormState } from '@/lib/form-state';
import styles from './submission-form.module.css';

type Props = {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  draftKey: string;
  requestId: string;
  groupName?: string;
  expectedGroupId?: string | null;
};
type Draft = { body: string; requestId: string; expectedGroupId: string | null };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// A changed account/task remounts the editor before any previous draft can appear.
export function SubmissionForm(props: Props) {
  return <DraftEditor key={props.draftKey} {...props}/>;
}

function DraftEditor({ action, draftKey, requestId, groupName, expectedGroupId = null }: Props) {
  const router = useRouter();
  const fieldId = useId();
  const storageKey = `design-course:submission:${draftKey}`;
  const [body, setBody] = useState('');
  const [token, setToken] = useState(requestId);
  const [ready, setReady] = useState(false);
  const [groupChanged, setGroupChanged] = useState(false);
  const [groupConfirmed, setGroupConfirmed] = useState(false);
  const [storageStatus, setStorageStatus] = useState('正在读取本浏览器草稿…');
  const [storageFailed, setStorageFailed] = useState(false);
  const current = useRef<Draft>({ body: '', requestId, expectedGroupId });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const processed = useRef<FormState | null>(null);

  function persist(draft: Draft) {
    try {
      if (draft.body) localStorage.setItem(storageKey, JSON.stringify(draft));
      else localStorage.removeItem(storageKey);
      setStorageFailed(false);
      setStorageStatus(draft.body ? '草稿已保存在本浏览器，尚未提交。' : '正文会自动保存在本浏览器，尚未提交。');
    } catch {
      setStorageFailed(true);
      setStorageStatus('未能保存本地草稿。输入仍在当前页面，请勿刷新或关闭，可先复制正文。');
    }
  }

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const draft: unknown = JSON.parse(saved);
        if (!draft || typeof draft !== 'object' || !('body' in draft) || typeof draft.body !== 'string' || draft.body.length > 12000) throw new Error('INVALID_DRAFT');
        const savedToken = 'requestId' in draft && typeof draft.requestId === 'string' && uuid.test(draft.requestId) ? draft.requestId : requestId;
        const savedGroup = 'expectedGroupId' in draft && typeof draft.expectedGroupId === 'string' ? draft.expectedGroupId : null;
        const changed = expectedGroupId !== null && savedGroup !== expectedGroupId;
        setGroupChanged(changed);
        current.current = { body: draft.body, requestId: savedToken, expectedGroupId: changed ? savedGroup : expectedGroupId };
        setBody(draft.body);
        setToken(savedToken);
        setStorageStatus('已恢复本浏览器中的草稿，尚未提交。');
      } else setStorageStatus('正文会自动保存在本浏览器，尚未提交。');
    } catch {
      setStorageFailed(true);
      setStorageStatus('无法读取本地草稿。当前输入仍可提交，但请自行保留副本。');
    }
    setReady(true);
    // The keyed editor owns exactly one account/task and initial request token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ready && expectedGroupId !== null && current.current.expectedGroupId !== expectedGroupId) {
      setGroupChanged(true);
      setGroupConfirmed(false);
    }
  }, [ready, expectedGroupId]);

  useEffect(() => {
    function flush() {
      if (!ready) return;
      clearTimeout(saveTimer.current);
      persist(current.current);
    }
    function onVisibility() { if (document.visibilityState === 'hidden') flush(); }
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(saveTimer.current);
      // Flush a pending edit when navigating between tasks without a page unload.
      if (ready) {
        try {
          if (current.current.body) localStorage.setItem(storageKey, JSON.stringify(current.current));
          else localStorage.removeItem(storageKey);
        } catch { /* The visible save status already describes storage failures. */ }
      }
    };
    // Each keyed editor has a stable storage key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const [state, formAction, pending] = useActionState(async (previous: FormState, form: FormData): Promise<FormState> => {
    clearTimeout(saveTimer.current);
    if ((expectedGroupId !== null && current.current.expectedGroupId !== expectedGroupId) || (groupChanged && !groupConfirmed)) return { error: '请先核对正文并确认当前提交小组。' };
    persist(current.current);
    try {
      const result = await action(previous, form);
      if (result.success) {
        const nextToken = crypto.randomUUID();
        current.current = { body: '', requestId: nextToken, expectedGroupId };
        setGroupChanged(false);
        setGroupConfirmed(false);
        setBody('');
        setToken(nextToken);
        try {
          localStorage.removeItem(storageKey);
          setStorageFailed(false);
          setStorageStatus('提交已成功，本浏览器草稿已清除。');
        } catch {
          setStorageFailed(true);
          setStorageStatus('提交已成功，但未能清除本浏览器草稿。再次打开时请核对提交记录，避免重复提交。');
        }
      }
      return result;
    } catch {
      return { error: '暂未确认提交结果，正文已保留。请先查看提交记录，再决定是否重试。' };
    }
  }, {});

  useEffect(() => {
    if (state.success && processed.current !== state) {
      processed.current = state;
      router.refresh();
    }
  }, [state, router]);

  return <form action={formAction} className={styles.form}>
    <input type="hidden" name="requestId" value={token}/>
    <input type="hidden" name="expectedGroupId" value={expectedGroupId || ''}/>
    {groupChanged && <div className={styles.groupWarning}><p id={`${fieldId}-group-warning`}>小组已变化，请核对正文；确认后将代表{groupName || '当前小组'}提交。</p><label className={styles.confirmGroup}><input type="checkbox" checked={groupConfirmed} disabled={pending} aria-describedby={`${fieldId}-group-warning`} onChange={event => {
      const confirmed = event.target.checked;
      setGroupConfirmed(confirmed);
      if (confirmed) {
        const nextToken = crypto.randomUUID();
        setToken(nextToken);
        current.current = { ...current.current, expectedGroupId, requestId: nextToken };
        persist(current.current);
      }
    }}/><span>我已核对正文，确认代表{groupName || '当前小组'}提交</span></label></div>}
    <div className="form-field"><label htmlFor={fieldId}>作业正文</label><textarea id={fieldId} name="body" value={body} onChange={event => {
      const next = event.target.value;
      if (next === current.current.body) return;
      const nextToken = crypto.randomUUID();
      setBody(next);
      setToken(nextToken);
      current.current = { ...current.current, body: next, requestId: nextToken };
      clearTimeout(saveTimer.current);
      setStorageStatus('正在保存本浏览器草稿…');
      saveTimer.current = setTimeout(() => persist(current.current), 500);
    }} rows={12} maxLength={12000} required readOnly={pending || !ready} aria-describedby={`${fieldId}-draft ${fieldId}-count`}/>
    <div className={styles.editorMeta}><p id={`${fieldId}-draft`} className={storageFailed ? styles.warning : styles.draftStatus} role="status">{storageStatus}</p><span id={`${fieldId}-count`}>{body.length} / 12000</span></div>
    {groupName && <p className="field-help">本次提交代表{groupName}，提交时的组员将保存在记录中。</p>}
    <p className="field-help">每次提交都会保留为独立版本，原有版本不会被覆盖。</p></div>
    {state.error && <div><p className="notice error" role="alert">{state.error}</p><p className="field-help">正文已保留。若刚才网络中断，请先查看提交记录，避免重复提交。</p></div>}
    {state.success && <p className="notice" role="status">{state.success}</p>}
    <div><button type="submit" className="button primary" disabled={pending || !ready || (expectedGroupId !== null && current.current.expectedGroupId !== expectedGroupId) || (groupChanged && !groupConfirmed)}>{pending ? '正在提交…' : '确认提交'}</button></div>
  </form>;
}


/** Read-only recovery never mutates the draft, its request token, or its group context. */
export function ReadOnlySubmissionDraft({ draftKey, reason }: { draftKey: string; reason: string }) {
  return <SavedDraftReader key={draftKey} draftKey={draftKey} reason={reason}/>;
}

function SavedDraftReader({ draftKey, reason }: { draftKey: string; reason: string }) {
  const fieldId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<'loading' | 'found' | 'empty' | 'error'>('loading');
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`design-course:submission:${draftKey}`);
      if (!saved) { setStatus('empty'); return; }
      const draft: unknown = JSON.parse(saved);
      if (!draft || typeof draft !== 'object' || !('body' in draft) || typeof draft.body !== 'string' || draft.body.length > 12000) throw new Error('INVALID_DRAFT');
      setBody(draft.body);
      setStatus(draft.body ? 'found' : 'empty');
    } catch { setStatus('error'); }
  }, [draftKey]);
  async function copyDraft() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
      await navigator.clipboard.writeText(body);
      setCopyStatus('草稿正文已复制。');
    } catch {
      textarea.current?.focus();
      textarea.current?.select();
      setCopyStatus('自动复制失败，已选中正文，请使用系统复制命令或长按复制。');
    }
  }
  return <div className={styles.savedDraft}>
    <p className={styles.readOnlyReason}>{reason}</p>
    <h3>本浏览器未提交草稿</h3>
    {status === 'loading' && <p role="status">正在读取草稿…</p>}
    {status === 'empty' && <p className="field-help">本浏览器没有此账号在这份作业中保存的草稿。</p>}
    {status === 'error' && <p className={styles.warning} role="status">无法读取本浏览器草稿，可能受到浏览器存储限制或草稿格式异常影响。此处不会清除原草稿。</p>}
    {status === 'found' && <><div className="form-field"><label htmlFor={fieldId}>草稿正文（只读）</label><textarea ref={textarea} id={fieldId} value={body} readOnly rows={10} aria-describedby={`${fieldId}-help`}/><p id={`${fieldId}-help`} className="field-help">此草稿仅保存在本浏览器，不是已提交版本。当前只能查看或复制，原草稿和分组信息不会被更改。</p></div><div><button className="button secondary" type="button" onClick={copyDraft}>复制草稿正文</button></div>{copyStatus && <p role="status" className="field-help">{copyStatus}</p>}</>}
  </div>;
}
