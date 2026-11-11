'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createCourseAction } from '@/lib/course-creation-actions';

export function CourseCreationForm({ requestId }: { requestId: string }) {
  const [stableRequestId] = useState(requestId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [state, action, pending] = useActionState(createCourseAction, {});
  const router = useRouter();
  useEffect(() => { if (state.redirectTo) router.push(state.redirectTo); }, [state, router]);
  return <form action={action} className="stack">
    <input type="hidden" name="requestId" value={stableRequestId}/>
    <div className="form-field"><label htmlFor="course-title">课程名称</label>
      <input id="course-title" name="title" required maxLength={100} autoComplete="off" value={title} onChange={event => setTitle(event.target.value)}/>
    </div>
    <div className="form-field"><label htmlFor="course-description">课程介绍（选填）</label>
      <textarea id="course-description" name="description" maxLength={2000} rows={4} value={description} onChange={event => setDescription(event.target.value)}/>
    </div>
    {state.error && <p className="notice error" role="alert">{state.error}</p>}
    <div><button type="submit" className="button primary" disabled={pending || !!state.redirectTo}>{pending ? '正在创建…' : '创建课程，继续开设学期'}</button></div>
  </form>;
}
