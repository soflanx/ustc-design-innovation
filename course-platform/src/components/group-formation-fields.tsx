'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './group-formation.module.css';

export function GroupFormationWindowFields({ initialCapacity, initialDeadline }: { initialCapacity: string; initialDeadline: string }) {
  const [capacity, setCapacity] = useState(initialCapacity);
  const [deadline, setDeadline] = useState(initialDeadline);
  return <div className={styles.fields}>
    <label className="form-field">每组最多人数<input name="capacity" type="number" required min={2} max={100} value={capacity} onChange={event => setCapacity(event.target.value)}/></label>
    <label className="form-field">组队截止（北京时间）<input name="closesAt" type="datetime-local" required value={deadline} onChange={event => setDeadline(event.target.value)}/></label>
  </div>;
}

type RecruitmentMode = 'COURSE' | 'INVITE' | 'CLOSED';

export function GroupRecruitmentFields({ creating = false, initialMode = '', initialNote = '' }: {
  creating?: boolean;
  initialMode?: RecruitmentMode | '';
  initialNote?: string;
}) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState(initialMode);
  const [note, setNote] = useState(initialNote);
  return <>
    {creating && <label className="form-field">小组名称<input name="name" required maxLength={100} value={name} onChange={event => setName(event.target.value)}/></label>}
    <label className="form-field">招募方式<select name="mode" required value={mode} onChange={event => setMode(event.target.value as RecruitmentMode)}>
      <option value="" disabled>请选择招募方式</option>
      <option value="COURSE">本班公开招募</option>
      <option value="INVITE">仅邀请链接</option>
      {!creating && <option value="CLOSED">停止招募</option>}
    </select></label>
    {mode === 'COURSE' && <p className={styles.note}>本期未分组同学可以在招募列表看到组名、说明和剩余名额。</p>}
    {mode === 'INVITE' && <p className={styles.note}>可把邀请链接发给本期未分组的同学。</p>}
    <label className="form-field">招募说明（选填）<textarea name="note" rows={3} maxLength={300} value={note} onChange={event => setNote(event.target.value)}/></label>
  </>;
}

export function GroupInvitationLink({ path }: { path: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(path);
  const [message, setMessage] = useState('');
  useEffect(() => { setUrl(new URL(path, window.location.origin).href); }, [path]);

  async function copyInvitation() {
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
      setMessage('邀请链接已复制。');
    } catch {
      input.current?.focus();
      input.current?.select();
      setMessage('链接已选中，可使用浏览器的复制操作。');
    }
  }

  return <div className={styles.invitation}>
    <label className="form-field">邀请链接<input ref={input} readOnly value={url}/></label>
    <div><button className="button secondary" type="button" onClick={copyInvitation}>复制邀请链接</button></div>
    <p className={styles.note} role="status">{message}</p>
  </div>;
}
