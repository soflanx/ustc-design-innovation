'use client';

import { useActionState, useCallback, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { addFeedbackAction } from '@/lib/teaching-actions';
import type { FormState } from '@/lib/form-state';
import styles from '@/app/teaching.module.css';

// Keep drafts across client-side filter changes even when tab storage is unavailable.
const unsavedToStorage = new Map<string, string>();

function readDraft(key: string) {
  if (unsavedToStorage.has(key)) return unsavedToStorage.get(key)!;
  try { return sessionStorage.getItem(key) ?? ''; }
  catch { return ''; }
}

function writeDraft(key: string, body: string) {
  try {
    if (body) sessionStorage.setItem(key, body);
    else sessionStorage.removeItem(key);
    unsavedToStorage.delete(key);
  } catch {
    unsavedToStorage.set(key, body);
  }
  window.dispatchEvent(new Event(key));
}

export function VersionFeedbackForm({ reviewerId, offeringId, versionId, recipientLabel, groupSubmission }: {
  reviewerId: string; offeringId: string; versionId: string; recipientLabel: string; groupSubmission: boolean;
}) {
  const router = useRouter();
  const key = `design-course:feedback:${JSON.stringify([reviewerId, offeringId, versionId])}`;
  const subscribe = useCallback((notify: () => void) => {
    window.addEventListener(key, notify);
    return () => window.removeEventListener(key, notify);
  }, [key]);
  const body = useSyncExternalStore(subscribe, () => readDraft(key), () => '');
  const [result, publish, pending] = useActionState(async (previous: FormState, form: FormData) => {
    try {
      const result = await addFeedbackAction(offeringId, versionId, previous, form);
      if (result.success) {
        // A delayed response only clears the exact text that was sent.
        if (readDraft(key) === form.get('body')) writeDraft(key, '');
        router.refresh();
      }
      return result;
    } catch {
      return { error: '暂未确认保存结果。请核对这份作品下的评语后再试。' };
    }
  }, {});

  return <details className={styles.reviewForm}>
    <summary>{body ? '写评语（有草稿）' : '写评语'}</summary>
    <div className={styles.editorContent}><form action={publish} className="stack">
      <input type="hidden" name="expectedUserId" value={reviewerId}/>
      <div className="form-field">
        <label htmlFor={`feedback-${versionId}`}>对这份作品的评语</label>
        <p id={`feedback-recipients-${versionId}`} className={styles.countHelp}>{groupSubmission
          ? `${recipientLabel}的本次参与学生及本组成员可见。`
          : `${recipientLabel}本人可见。`}</p>
        <textarea id={`feedback-${versionId}`} name="body" aria-describedby={`feedback-recipients-${versionId}`} rows={5} maxLength={12000} required readOnly={pending}
          value={body} onChange={event => writeDraft(key, event.target.value)}/>
        {body && <p className={styles.countHelp}>在此标签页返回这份作品，可继续填写草稿。</p>}
      </div>
      {result.error && <p className="notice error" role="alert">{result.error}</p>}
      {result.success && !body && <p className="notice" role="status">{result.success}</p>}
      <div><button type="submit" className="button primary" disabled={pending}>{pending ? '正在保存…' : '保存评语'}</button></div>
    </form></div>
  </details>;
}
