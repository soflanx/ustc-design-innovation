'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createCourseSubpageAction } from '@/lib/course-subpage-actions';
import styles from './course-weekly-preparation.module.css';

type Choice = { id: string; title: string };

export function CourseLessonStarter({ offeringId, authorId, assignments, resources }: {
  offeringId: string;
  authorId: string;
  assignments: Choice[];
  resources: Choice[];
}) {
  const field = useId();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignmentId, setAssignmentId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<string | null>(null);
  const busy = useRef(false);

  async function create() {
    if (busy.current || !title.trim()) return;
    busy.current = true;
    setPending(true);
    setError('');
    request.current ??= crypto.randomUUID();
    try {
      const result = await createCourseSubpageAction(offeringId, title, request.current, authorId, {
        body, assignmentId: assignmentId || undefined, resourceId: resourceId || undefined,
      });
      if (!result.pageId) { setError(result.error || '课次尚未创建，请重试。'); return; }
      router.push(`/courses/${encodeURIComponent(offeringId)}/pages/${encodeURIComponent(result.pageId)}?edit=1`);
    } catch {
      setError('暂未确认创建结果，填写内容仍在，可直接重试。');
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return <details className={styles.starter}>
    <summary>新建课次</summary>
    <form className={styles.form} aria-label="新建课次" onSubmit={event => { event.preventDefault(); void create(); }}>
      <div className="form-field">
        <label htmlFor={`${field}-title`}>课次标题</label>
        <input id={`${field}-title`} type="text" value={title} maxLength={100} required readOnly={pending}
          placeholder="例如：第九周 · 分组点评" onChange={event => { setTitle(event.target.value); request.current = null; }}/>
        <label htmlFor={`${field}-body`}>课次正文（选填）</label>
        <textarea id={`${field}-body`} rows={4} maxLength={12000} value={body} readOnly={pending}
          onChange={event => { setBody(event.target.value); request.current = null; }}/>
      </div>
      {(assignments.length > 0 || resources.length > 0) && <details className={styles.references}>
        <summary>引用已有作业或资料</summary>
        <div className="form-field">
          {assignments.length > 0 && <>
            <label htmlFor={`${field}-assignment`}>已发布作业</label>
            <select id={`${field}-assignment`} value={assignmentId} disabled={pending} onChange={event => { setAssignmentId(event.target.value); request.current = null; }}>
              <option value="">不选作业</option>
              {assignments.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </>}
          {resources.length > 0 && <>
            <label htmlFor={`${field}-resource`}>已发布资料</label>
            <select id={`${field}-resource`} value={resourceId} disabled={pending} onChange={event => { setResourceId(event.target.value); request.current = null; }}>
              <option value="">不选资料</option>
              {resources.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </>}
          <p className="field-help">沿用原作业要求和截止时间。需要再添加材料时，可在课次里继续编辑。</p>
        </div>
      </details>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className={styles.actions}>
        <button className="button primary" type="submit" disabled={pending || !title.trim()}>{pending ? '正在创建…' : '保存课次草稿'}</button>
        <p className="field-help">保存后可在该课次发布内容，也可直接开始记录。</p>
      </div>
    </form>
  </details>;
}
