'use client';

import { useEffect, useRef, useState, useSyncExternalStore, useTransition, type FormEvent } from 'react';
import { readGroupPageRevisionAction, saveGroupPageAction } from '@/lib/actions';
import { hasGroupDraftChanges, startGroupEdit, type GroupEdit } from '@/lib/group-page-draft';
import type { GroupPageContent, GroupPageHistoryEntry, GroupPageRevisionContent } from '@/lib/management';
import styles from './group-page-editor.module.css';

function savedTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

// Unsubmitted changes survive client navigation within this document only.
const drafts = new Map<string, GroupEdit>();
const listeners = new Set<() => void>();
function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}
function storeDraft(key: string, next: GroupEdit | null) {
  if (next) drafts.set(key, next);
  else drafts.delete(key);
  for (const notify of listeners) notify();
}
const noDraft = () => null;

export function GroupPageEditor({ viewerId, offeringId, groupId, initial, history, canEdit, archived }: {
  viewerId: string;
  offeringId: string;
  groupId: string;
  initial: GroupPageContent;
  history: GroupPageHistoryEntry[];
  canEdit: boolean;
  archived: boolean;
}) {
  const key = JSON.stringify([viewerId, offeringId, groupId]);
  const stored = useSyncExternalStore(subscribe, () => canEdit || archived ? drafts.get(key) ?? null : null, noDraft);
  const [clean, setClean] = useState(() => startGroupEdit(initial));
  const edit = stored ?? (initial.revision > clean.baseline.revision ? startGroupEdit(initial) : clean);
  const { title, body, baseline: saved, restoredRevision } = edit;
  const conflict = initial.revision > (edit.conflict?.revision ?? saved.revision) ? initial : edit.conflict;
  const checkedConflict = !!conflict && edit.checkedRevision === conflict.revision;
  const [open, setOpen] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [selected, setSelected] = useState<GroupPageRevisionContent | null>(null);
  const [restoreCandidate, setRestoreCandidate] = useState<GroupPageRevisionContent | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [loadingRevision, setLoadingRevision] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const titleInput = useRef<HTMLInputElement>(null);
  const dirty = !!stored;

  function change(fields: Partial<GroupEdit>) {
    if (!canEdit) return;
    const next = { ...(drafts.get(key) ?? edit), ...fields };
    if (initial.revision > (next.conflict?.revision ?? next.baseline.revision)) next.conflict = initial;
    if (hasGroupDraftChanges(next)) storeDraft(key, next);
    else {
      setClean(next);
      storeDraft(key, null);
    }
  }

  useEffect(() => {
    if (!canEdit && !archived && drafts.has(key)) storeDraft(key, null);
  }, [canEdit, archived, key]);

  // Revalidation must not replace a member's local draft with another save.
  useEffect(() => {
    if (!dirty) return;
    const protectDraft = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const protectNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const destination = new URL(anchor.href, window.location.href);
      // Full navigation is covered by beforeunload; only guard the same-origin
      // links that Next can follow without unloading this editor.
      if (destination.origin !== window.location.origin || (destination.pathname === window.location.pathname && destination.search === window.location.search)) return;
      if (!window.confirm('小组记录还有未保存的修改。离开后这些修改将丢失，仍要离开吗？')) {
        event.preventDefault(); event.stopPropagation();
      } else storeDraft(key, null);
    };
    window.addEventListener('beforeunload', protectDraft);
    if (canEdit) document.addEventListener('click', protectNavigation, true);
    return () => { window.removeEventListener('beforeunload', protectDraft); document.removeEventListener('click', protectNavigation, true); };
  }, [dirty, canEdit, key]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !canEdit || (conflict && !checkedConflict)) return;
    const form = new FormData(event.currentTarget);
    setError(''); setSuccess('');
    startTransition(async () => {
      try {
        const result = await saveGroupPageAction(offeringId, groupId, viewerId, form);
        // An old response must not replace edits made after returning to this group.
        if ((drafts.get(key) ?? null) !== stored) return;
        if (result.conflict) {
          change({ conflict: result.conflict, checkedRevision: null });
        }
        if (result.error) { setError(result.error); return; }
        if (result.saved) {
          change(startGroupEdit(result.saved));
          setSuccess(result.success || '记录已保存。');
        }
      } catch {
        setError('保存未完成，当前编辑仍保留在这里，请重试。');
      }
    });
  }

  function showRevision(revision: number) {
    setHistoryError(''); setLoadingRevision(revision); setRestoreCandidate(null);
    startTransition(async () => {
      try {
        const result = await readGroupPageRevisionAction(offeringId, groupId, viewerId, revision);
        if (result.error) { setHistoryError(result.error); return; }
        if (result.snapshot) setSelected(result.snapshot);
      } catch {
        setHistoryError('历史记录暂时无法读取，请重试。');
      } finally {
        setLoadingRevision(null);
      }
    });
  }

  function restore(snapshot: GroupPageRevisionContent) {
    change({ title: snapshot.title, body: snapshot.body, restoredRevision: snapshot.revision, checkedRevision: null });
    setRestoreCandidate(null); setOpen(true); setSuccess(''); setError('');
    // Keep the current editing base. A restoration is a new save and must pass
    // the same revision check as any other edit, including after a conflict.
    requestAnimationFrame(() => { titleInput.current?.focus(); titleInput.current?.scrollIntoView({ behavior: 'auto', block: 'center' }); });
  }

  return <div className={styles.root}>
    {archived && stored && <details className={styles.history}>
      <summary>本标签页的未保存草稿</summary>
      <div className={styles.form}>
        <p className={styles.meta}>这份草稿仅保存在当前标签页。关闭或刷新前，可复制留存。</p>
        <label className="form-field">草稿标题与正文（只读）
          <textarea readOnly rows={8} value={`${stored.title}\n\n${stored.body}`} onFocus={event => event.currentTarget.select()}/>
        </label>
      </div>
    </details>}
    {canEdit && <details className={styles.editor} open={open ?? dirty} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>编辑项目标题与工作记录{dirty && <span className={styles.unsaved}>未保存</span>}</summary>
      <form onSubmit={submit} className={styles.form}>
        <input type="hidden" name="expectedRevision" value={conflict && checkedConflict ? conflict.revision : saved.revision}/>
        {error && <p className="notice error" role="alert">{error}</p>}
        {conflict && <section className={styles.conflict} aria-labelledby={`group-conflict-${groupId}`}>
          <h3 id={`group-conflict-${groupId}`}>另一位成员已更新记录</h3>
          <p>你的编辑已保留在下方。请先对照最新记录，合并需要保留的内容，再保存。</p>
          <div className={styles.serverCopy}>
            <p className={styles.meta}>服务器最新记录 · 第 {conflict.revision} 版{conflict.updatedAt && <> · {savedTime(conflict.updatedAt)}</>}</p>
            <h4>{conflict.title}</h4>
            <div className={styles.body}>{conflict.body}</div>
          </div>
          <label className={styles.confirm}><input type="checkbox" checked={checkedConflict} disabled={pending} onChange={event => change({ conflict, checkedRevision: event.target.checked ? conflict.revision : null })}/><span>我已核对最新记录，下方内容保留了需要的修改</span></label>
        </section>}
        {conflict && <h3 className={styles.localHeading}>我的编辑（尚未保存）</h3>}
        {restoredRevision !== null && <p className={styles.hint} role="status">已将第 {restoredRevision} 版载入编辑区。保存后会形成新版本，当前线上记录尚未改变。</p>}
        <fieldset className={styles.fields} disabled={pending}>
          <div className="form-field"><label htmlFor={`page-title-${groupId}`}>项目标题</label><input ref={titleInput} id={`page-title-${groupId}`} name="title" maxLength={100} required value={title} onChange={event => { change({ title: event.target.value }); setSuccess(''); }}/></div>
          <div className="form-field"><label htmlFor={`page-body-${groupId}`}>工作记录</label><textarea id={`page-body-${groupId}`} name="body" rows={12} maxLength={12000} required value={body} onChange={event => { change({ body: event.target.value }); setSuccess(''); }}/><p className="field-help">本组成员与教学团队可查看。每次保存都会保留一个历史版本。</p></div>
        </fieldset>
        {success && <p className="notice" role="status">{success}</p>}
        <div className={styles.actions}><button className="button primary" type="submit" disabled={pending || (!!conflict && !checkedConflict)}>{pending ? '正在处理…' : '保存记录'}</button>{saved.revision > 0 && <span className={styles.meta}>正在编辑第 {conflict && checkedConflict ? conflict.revision : saved.revision} 版</span>}</div>
      </form>
    </details>}
    <details className={styles.history}>
      <summary>记录历史{history.length > 0 && `（${history.length}）`}</summary>
      {history.length ? <ol className={styles.versions}>{history.map(item => <li key={item.revision}>
        <button type="button" className={styles.versionButton} disabled={pending} aria-pressed={selected?.revision === item.revision} onClick={() => showRevision(item.revision)}>
          <span>第 {item.revision} 版 · {item.title}{item.isBaseline && ' · 历史基线'}</span>
          <span className={styles.meta}>{savedTime(item.createdAt)} · {item.actorName || '作者未记录'}{loadingRevision === item.revision && ' · 读取中…'}</span>
        </button>
      </li>)}</ol> : <p className={styles.hint}>尚无已保存的历史版本。</p>}
      {historyError && <p className="notice error" role="alert">{historyError}</p>}
      {selected && <section className={styles.snapshot} aria-label={`第 ${selected.revision} 版记录内容`}>
        <div className={styles.snapshotHeading}><h3>第 {selected.revision} 版</h3>{canEdit && <button type="button" className="button secondary" disabled={pending} onClick={() => dirty ? setRestoreCandidate(selected) : restore(selected)}>载入此版本到编辑区</button>}</div>
        {selected.isBaseline && <p className={styles.hint}>这是启用历史记录时留存的内容，不代表此前的修改过程。</p>}
        <h4>{selected.title}</h4><div className={styles.body}>{selected.body}</div>
        {canEdit && restoreCandidate && <div className={styles.restoreConfirm} role="alert"><p>编辑区还有未保存的修改。用第 {restoreCandidate.revision} 版替换编辑区内容？线上记录不会改变。</p><div className={styles.actions}><button type="button" className="button secondary" disabled={pending} onClick={() => setRestoreCandidate(null)}>保留当前编辑</button><button type="button" className="button" disabled={pending} onClick={() => restore(restoreCandidate)}>替换编辑区内容</button></div></div>}
      </section>}
    </details>
  </div>;
}
