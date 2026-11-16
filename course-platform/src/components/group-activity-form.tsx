'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { saveGroupActivityAction, withdrawGroupActivityAction } from '@/lib/group-activity-actions';
import type { FormState } from '@/lib/form-state';
import { MAX_SUBMISSION_FILE_BYTES, MAX_SUBMISSION_FILES } from '@/lib/submission-contract';
import styles from './group-activities.module.css';

type ActivityScope = { viewerId: string; offeringId: string; groupId: string };

export function GroupActivityForm({ offeringId, groupId, viewerId, members, today }: ActivityScope & {
  members: { id: string; name: string }[];
  today: string;
}) {
  const field = useId();
  const disclosure = useRef<HTMLDetailsElement>(null);
  const requestId = useRef<string | null>(null);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<FormState>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const files = data.getAll('attachments').filter((entry): entry is File => typeof entry !== 'string' && !!entry.name);
    if (files.length > MAX_SUBMISSION_FILES || files.reduce((total, file) => total + file.size, 0) > MAX_SUBMISSION_FILE_BYTES) {
      setResult({ error: '每次可选最多 20 件附件，合计不超过 10 MiB。' });
      return;
    }
    busy.current = true;
    setPending(true);
    setResult(undefined);
    try {
      requestId.current ??= crypto.randomUUID();
      data.set('requestId', requestId.current);
      const saved = await saveGroupActivityAction(offeringId, groupId, viewerId, data);
      setResult(saved);
      if (saved.success) {
        form.reset();
        requestId.current = null;
        const details = disclosure.current;
        if (details) {
          details.open = false;
          details.querySelector('summary')?.focus();
        }
      }
    } catch {
      setResult({ error: '暂未确认保存结果。填写的内容和文件仍在，可直接重试。' });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return <div>
    <details ref={disclosure} className={styles.editor}>
      <summary>记一次工作</summary>
      <form method="post" className={styles.form} aria-label="记一次工作" onSubmit={submit} onChange={() => { requestId.current = null; setResult(undefined); }}>
        <fieldset className={styles.fields} disabled={pending}>
          <div className="form-field">
            <label htmlFor={`${field}-body`}>工作内容</label>
            <textarea id={`${field}-body`} name="body" rows={3} maxLength={12000} placeholder="记下有用的发现或决定"/>
            <label htmlFor={`${field}-attachments`}>照片或文件</label>
            <input id={`${field}-attachments`} type="file" name="attachments" multiple aria-describedby={`${field}-file-help`}/>
            <p id={`${field}-file-help`} className="field-help">最多 20 件，合计不超过 10 MiB。</p>
            <label htmlFor={`${field}-next-step`}>下一步（选填）</label>
            <textarea id={`${field}-next-step`} name="nextStep" rows={2} maxLength={1000}/>
          </div>
          <details className={styles.metadataOptions}>
            <summary>补充日期和参与者</summary>
            <div className="form-field">
              <label htmlFor={`${field}-date`}>实际发生日期</label>
              <input id={`${field}-date`} type="date" name="occurredOn" max={today}/>
            </div>
            {members.length > 0 && <fieldset className={styles.members}>
              <legend>参与者</legend>
              {members.map(member => <label key={member.id}>
                <input type="checkbox" name="participantIds" value={member.id}/>
                {member.name}
              </label>)}
            </fieldset>}
          </details>
        </fieldset>
        {result?.error && <p className="notice error" role="alert">{result.error}</p>}
        <div className={styles.actions}>
          <button className="button primary" type="submit" disabled={pending}>{pending ? '正在保存…' : '保存记录'}</button>
          <p className="field-help">自愿记录，本组成员和本期教学团队可见。</p>
        </div>
      </form>
    </details>
    {result?.success && <p className="notice" role="status">{result.success}</p>}
  </div>;
}

export function GroupActivityWithdraw({ offeringId, groupId, viewerId, activityId }: ActivityScope & { activityId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await withdrawGroupActivityAction(offeringId, groupId, viewerId, activityId);
      setError(result.error);
    } catch {
      setError('暂未确认撤回结果，可重试。');
    } finally {
      setPending(false);
    }
  }

  return <details className={styles.withdraw}>
    <summary>撤回这条记录</summary>
    <form method="post" onSubmit={submit} className={styles.form}>
      <p className="field-help">撤回会移除组页上的记录和附件入口，原附件地址也会失效。</p>
      <div><button type="submit" className="button" disabled={pending}>{pending ? '正在撤回…' : '确认撤回'}</button></div>
      {error && <p className="notice error" role="alert">{error}</p>}
    </form>
  </details>;
}
