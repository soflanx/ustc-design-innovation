'use client';

import { useContext, useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { correctTeachingObservationAction, withdrawTeachingObservationAction } from '@/lib/teaching-observation-actions';
import { toTeachingDateInput } from '@/lib/teaching-format';
import { TeachingRecordsNoticeContext } from './teaching-records-notice';
import styles from './teaching-records.module.css';

export function TeachingRecordsAmendment({ offeringId, authorId, record, confirmedLeave, canCorrect, canWithdraw, historyHref }: {
  offeringId: string;
  authorId: string;
  record: { id: string; revision: number; body: string; context: string; observedAt: string | null };
  confirmedLeave: boolean;
  canCorrect: boolean;
  canWithdraw: boolean;
  historyHref?: string;
}) {
  const field = useId();
  const router = useRouter();
  const showNotice = useContext(TeachingRecordsNoticeContext);
  const [editing, setEditing] = useState<{ mode: 'correct' | 'withdraw'; original: typeof record }>();
  const [editLegacyDate, setEditLegacyDate] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const working = useRef(false);
  const disclosure = useRef<HTMLDetailsElement>(null);
  const lastRequest = useRef<{ signature: string; requestId: string } | null>(null);
  const mode = editing?.mode;
  const originalDate = toTeachingDateInput(editing?.original.observedAt ?? null).slice(0, 10);
  const today = toTeachingDateInput(new Date()).slice(0, 10);
  const legacyFutureDate = originalDate > today;
  const withdrawOnly = canWithdraw && !canCorrect;

  function selectMode(next?: 'correct' | 'withdraw') {
    setEditing(next ? { mode: next, original: record } : undefined);
    setEditLegacyDate(false);
    setError(undefined);
  }

  function cancel() {
    if (withdrawOnly && disclosure.current) disclosure.current.open = false;
    selectMode();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || working.current) return;
    const data = new FormData(event.currentTarget);
    const reason = String(data.get('reason') ?? '');
    working.current = true;
    setPending(true);
    setError(undefined);
    try {
      const date = data.get('date');
      const changedDate = typeof date === 'string' && date !== originalDate
        ? { observedAt: date ? new Date(`${date}T00:00:00+08:00`).toISOString() : null }
        : {};
      const correction = editing.mode === 'correct' ? {
        body: String(data.get('body') ?? ''),
        context: String(data.get('context') ?? ''),
        ...changedDate,
      } : null;
      // A refresh may bring in a newer revision while this form is open.
      const expectedRevision = editing.original.revision;
      const signature = JSON.stringify([editing.mode, expectedRevision, correction, reason]);
      if (lastRequest.current?.signature !== signature) {
        lastRequest.current = { signature, requestId: crypto.randomUUID() };
      }
      const input = { expectedRevision, reason, requestId: lastRequest.current.requestId };
      const result = correction
        ? await correctTeachingObservationAction(offeringId, authorId, record.id, { ...input, ...correction })
        : await withdrawTeachingObservationAction(offeringId, authorId, record.id, input);
      if (result.success) {
        showNotice?.({ message: result.success, historyHref: correction ? undefined : historyHref });
        if (disclosure.current) disclosure.current.open = false;
        setEditing(undefined);
        lastRequest.current = null;
        router.refresh();
      } else {
        setError(result.error);
      }
    } catch {
      setError('暂未确认结果。内容仍在，可直接重试。');
    } finally {
      working.current = false;
      setPending(false);
    }
  }

  return <details ref={disclosure} className={styles.amendment} onToggle={event => {
    if (event.currentTarget.open && withdrawOnly && !mode) selectMode('withdraw');
  }}>
    <summary className={styles.disclosure}>{withdrawOnly ? '撤回记录' : canWithdraw ? '更正或撤回' : '更正内容'}</summary>
    {!mode && !withdrawOnly && <div className={styles.actions}>
      {canCorrect && <button className="button" type="button" onClick={() => selectMode('correct')}>更正内容</button>}
      {canWithdraw && <button className="button" type="button" onClick={() => selectMode('withdraw')}>撤回记录</button>}
    </div>}
    {editing && <form key={mode} className={styles.noteForm} onSubmit={submit}>
      {mode === 'correct' ? <>
        <p className={styles.meta}>更正正文、来源或日期，原记录会保留在历史中。</p>
        <div className="form-field">
          <label htmlFor={`${field}-body`}>更正后的正文</label>
          <textarea id={`${field}-body`} name="body" rows={3} maxLength={12000} defaultValue={editing.original.body} required readOnly={pending}/>
          <label htmlFor={`${field}-context`}>{confirmedLeave ? '请假确认来源（必填）' : '情境或来源（选填）'}</label>
          <input id={`${field}-context`} name="context" defaultValue={editing.original.context} maxLength={1000} required={confirmedLeave} readOnly={pending}/>
          {(!legacyFutureDate || editLegacyDate) && <>
            <label htmlFor={`${field}-date`}>实际发生日期（选填）</label>
            <input id={`${field}-date`} name="date" type="date" max={today} defaultValue={legacyFutureDate ? '' : originalDate} readOnly={pending}/>
          </>}
        </div>
        {legacyFutureDate && <div className={styles.actions}>
          <p className={styles.meta}>原记录的发生日期是 {originalDate}。{editLegacyDate ? '留空会清除原日期。' : '本次更正默认保留原日期。'}</p>
          <button className="button" type="button" disabled={pending} onClick={() => setEditLegacyDate(value => !value)}>{editLegacyDate ? '保留原日期' : '更改日期'}</button>
        </div>}
      </> : <p className={styles.meta}>撤回后，原正文、原作者和撤回人都会留在历史中。若记错了对象，可另记一条给正确对象。</p>}
      <div className="form-field">
        <label htmlFor={`${field}-reason`}>{mode === 'correct' ? '更正说明（选填）' : '撤回原因（必填）'}</label>
        <input id={`${field}-reason`} name="reason" maxLength={1000} required={mode === 'withdraw'} readOnly={pending}/>
      </div>
      <div className={styles.actions}>
        <button className="button primary" type="submit" disabled={pending}>{pending ? '正在保存…' : mode === 'correct' ? '保存更正' : '确认撤回'}</button>
        <button className="button" type="button" disabled={pending} onClick={cancel}>返回</button>
      </div>
    </form>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </details>;
}
