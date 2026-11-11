'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { TermStatus } from '@prisma/client';
import { saveOfferingIntroductionAction } from '@/lib/offering-introduction-actions';
import styles from './offering-introduction-form.module.css';

export function OfferingIntroductionForm({ offeringId, authorId, status, description }: {
  offeringId: string; authorId: string; status: TermStatus; description: string;
}) {
  const [baseline, setBaseline] = useState(description);
  const [text, setText] = useState(description);
  const [conflict, setConflict] = useState<string>();
  const [notice, setNotice] = useState<{ message: string; error?: boolean }>();
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const section = useRef<HTMLDetailsElement>(null);
  const field = useId();
  const archived = status === 'ARCHIVED';
  const dirty = text !== baseline;
  const keepEditor = dirty || conflict !== undefined;
  const previewLabel = status === 'DRAFT' ? '预览公开课程页' : '查看公开课程页';

  useEffect(() => {
    function reveal() {
      if (location.hash === '#public-introduction' && section.current) section.current.open = true;
    }
    reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, []);

  async function save(expected: string) {
    if (archived || sending.current) return;
    sending.current = true;
    setPending(true);
    setNotice(undefined);
    try {
      const result = await saveOfferingIntroductionAction(offeringId, authorId, expected, text);
      if ('error' in result) {
        setNotice({ message: result.error, error: true });
        if (result.conflictDescription !== undefined) setConflict(result.conflictDescription);
      } else {
        setBaseline(result.description);
        setText(result.description);
        setConflict(undefined);
        setNotice({ message: result.success });
      }
    } catch {
      setNotice({ message: '暂未确认保存结果。当前文字已保留，可查看公开课程页核对后重试。', error: true });
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  return <details id="public-introduction" ref={section} className={styles.section}>
    <summary>本期公开介绍</summary>
    <div className={styles.content}>
      {archived ? <p className={styles.savedText}>{description || '本期未填写公开介绍。'}</p> : <form className={styles.form} onSubmit={event => {
        event.preventDefault();
        if (conflict === undefined) void save(baseline);
      }}>
        <div className="form-field">
          <label htmlFor={field}>本期开课说明</label>
          <textarea id={field} name="description" value={text} rows={5} maxLength={2000} readOnly={pending}
            aria-describedby={`${field}-scope`} onChange={event => { setText(event.target.value); setNotice(undefined); }}/>
          <p id={`${field}-scope`} className="field-help">{status === 'DRAFT'
            ? '这段介绍用于本期公开课程页。筹备期间本期成员可预览，开课后访客即可查看。'
            : '保存后，访客和本期师生都可在本期公开课程页查看这段介绍。'}</p>
        </div>
        {notice && <p className={notice.error ? 'notice error' : 'field-help'} role={notice.error ? 'alert' : 'status'}>{notice.message}</p>}
        {conflict === undefined ? <div><button type="submit" className="button primary" disabled={pending || !dirty}>{pending ? '保存中…' : '保存本期介绍'}</button></div> :
          <div className={styles.comparison}>
            <strong>当前已保存的本期介绍</strong>
            <p className={styles.savedText}>{conflict || '（未填写）'}</p>
            <div className="inline-actions">
              <button type="button" className="button primary" disabled={pending || text === conflict} onClick={() => void save(conflict)}>
                {pending ? '保存中…' : '已核对，保存我的修改'}
              </button>
              <button type="button" className="button" disabled={pending} onClick={() => {
                setText(conflict);
                setBaseline(conflict);
                setConflict(undefined);
                setNotice({ message: '已载入最新版。' });
              }}>载入最新版</button>
            </div>
          </div>}
      </form>}
      <a href={`/courses/${encodeURIComponent(offeringId)}?view=public`} target={keepEditor ? '_blank' : undefined}
        rel={keepEditor ? 'noopener noreferrer' : undefined} aria-label={keepEditor ? `${previewLabel}（新标签页）` : undefined}>
        {previewLabel}{keepEditor && <span aria-hidden="true"> ↗</span>}
      </a>
    </div>
  </details>;
}
