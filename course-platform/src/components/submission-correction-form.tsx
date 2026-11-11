'use client';

import { useActionState } from 'react';
import type { FormState } from '@/lib/form-state';
import { formatTeachingDate, toTeachingDateInput } from '@/lib/teaching-format';

export function SubmissionCorrectionForm({ action, reviewerId, revision, until, owner, paused = false }: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  reviewerId: string; revision: number; until: string | null; owner: string; paused?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const open = !!until && Date.parse(until) > Date.now();
  return <details open={!!state.error || undefined}>
    <summary>{paused ? '更正授权已暂停' : open ? '管理更正期限' : '为此成果开放更正'}</summary>
    <form action={formAction}>
      <input type="hidden" name="expectedUserId" value={reviewerId}/>
      <input type="hidden" name="expectedRevision" value={revision}/>
      <p className="field-help">{paused ? `${owner}的更正授权已暂停，原期限为 ${formatTeachingDate(until)}。仅恢复发布且未到期时继续生效。` : open ? `${owner}可更正至 ${formatTeachingDate(until)}。` : `只允许${owner}更正已交成果，其他学生的截止时间不变。`}</p>
      {!paused && <label className="form-field">更正截止（北京时间）
        <input type="datetime-local" name="until" required defaultValue={open ? toTeachingDateInput(until) : ''}/>
      </label>}
      <div className="inline-actions">
        {!paused && <button type="submit" name="operation" value="open" className="button secondary" disabled={pending}>{open ? '更新更正期限' : '确认开放更正'}</button>}
        {open && <button type="submit" name="operation" value="revoke" formNoValidate className="button secondary" disabled={pending}>撤销更正</button>}
      </div>
      {state.error && <p role="alert" className="notice error">{state.error}</p>}
      {state.success && <p role="status" className="field-help">{state.success}</p>}
    </form>
  </details>;
}
