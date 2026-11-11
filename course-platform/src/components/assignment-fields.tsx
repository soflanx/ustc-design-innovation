'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AssignmentMode, AssignmentStatus } from '@prisma/client';
import type { AssignmentEditState } from '@/lib/teaching-actions';
import { toTeachingDateInput } from '@/lib/teaching-format';
import { AssignmentRequirementsField, type AssignmentMaterial } from './assignment-requirements-field';
import styles from '@/app/teaching.module.css';

type AssignmentValues = {
  id: string;
  offeringId: string;
  title: string;
  description: string;
  mode: AssignmentMode;
  status: AssignmentStatus;
  dueAt: Date | null;
  versionCount: number;
  revision: number;
  cancellationReason: string | null;
  maxScore: number;
  pendingCorrectionCount?: number;
};

export function AssignmentEditForm({ assignment, materials, saveAction }: {
  assignment: AssignmentValues;
  materials: AssignmentMaterial[];
  saveAction: (state: AssignmentEditState, form: FormData) => Promise<AssignmentEditState>;
}) {
  const router = useRouter();
  // A refreshed list must not attach newer defaults or a newer revision to an ongoing edit.
  const [editingFrom, setEditingFrom] = useState<AssignmentValues | null>(null);
  const baseline = editingFrom ?? assignment;
  const [result, submit, pending] = useActionState(async (previous: AssignmentEditState, form: FormData): Promise<AssignmentEditState> => {
    try {
      const saved = await saveAction(previous, form);
      if (saved.success) {
        setEditingFrom(null);
        router.refresh();
      }
      return saved;
    } catch {
      return { error: '暂未确认保存结果。请保留当前修改，核对作业记录后再试。' };
    }
  }, {});
  function keepBaseline() { setEditingFrom(baseline); }
  // React resets uncontrolled inputs even when an action resolves with a validation error.
  // After success the revision key below initializes the fields from the saved record.
  return <form action={submit} className="stack" onChange={keepBaseline} onSubmit={keepBaseline} onReset={event => event.preventDefault()}>
    <AssignmentFieldsForm key={baseline.revision} assignment={baseline} materials={materials} onEdit={keepBaseline} disabled={pending}/>
    {result.error && <p className="notice error" role="alert">{result.error}{result.revisionConflict && <>
      {' '}<a href={`?edit=${encodeURIComponent(assignment.id)}#edit-${encodeURIComponent(assignment.id)}`} target="_blank" rel="noopener">在新标签页编辑最新版 →</a>
    </>}</p>}
    {result.success && <p className="notice" role="status">{result.success}</p>}
    <div><button type="submit" className="button primary" disabled={pending}>{pending ? '正在保存…' : '保存作业'}</button></div>
  </form>;
}

function AssignmentFieldsForm({ assignment, materials, onEdit, disabled }: { assignment: AssignmentValues; materials: AssignmentMaterial[]; onEdit: () => void; disabled: boolean }) {
  const [status, setStatus] = useState(assignment.status);
  const [description, setDescription] = useState(assignment.description);
  const suffix = assignment.id;
  return <fieldset className={styles.fieldset} disabled={disabled}>
    <input type="hidden" name="expectedRevision" value={assignment.revision}/>
    <div className="form-field"><label htmlFor={`title-${suffix}`}>作业标题</label><input id={`title-${suffix}`} name="title" required maxLength={100} defaultValue={assignment.title}/></div>
    <AssignmentRequirementsField id={`description-${suffix}`} rows={5} offeringId={assignment.offeringId}
      description={description} materials={materials} onChange={value => { onEdit(); setDescription(value); }}/>
    <div className={styles.formGrid}>
      <div className="form-field"><label htmlFor={`mode-${suffix}`}>提交方式</label><select id={`mode-${suffix}`} name="mode" defaultValue={assignment.mode}>
        {(!assignment.versionCount || assignment.mode === 'INDIVIDUAL') && <option value="INDIVIDUAL">个人作业</option>}
        {(!assignment.versionCount || assignment.mode === 'GROUP') && <option value="GROUP">小组作业</option>}
      </select>{assignment.versionCount > 0 && <p className="field-help">已有提交，提交方式保持不变。</p>}</div>
      <div className="form-field"><label htmlFor={`due-${suffix}`}>截止时间（北京时间）</label><input id={`due-${suffix}`} type="datetime-local" name="dueAt" defaultValue={toTeachingDateInput(assignment.dueAt)}/><p className="field-help">留空表示不设截止时间。</p></div>
      <input type="hidden" name="maxScore" value={assignment.maxScore}/>
      <div className="form-field"><label htmlFor={`status-${suffix}`}>作业状态</label><select id={`status-${suffix}`} name="status" value={status} onChange={event => setStatus(event.target.value as AssignmentStatus)}>
        {assignment.status === 'DRAFT' && <option value="DRAFT">草稿</option>}
        <option value="PUBLISHED">{assignment.status === 'CANCELLED' ? '恢复发布' : '已发布'}</option>
        {assignment.status !== 'DRAFT' && assignment.status !== 'CANCELLED' && <option value="ARCHIVED">已结束</option>}
        {assignment.status !== 'DRAFT' && <option value="CANCELLED">已取消</option>}
      </select></div>
    </div>
    {assignment.status === 'CANCELLED' && (assignment.pendingCorrectionCount ?? 0) > 0 && <p className="notice">
      仍有 {assignment.pendingCorrectionCount} 份成果的更正授权尚未到期，目前因取消暂停。恢复发布时，尚未到期的授权会继续生效。{' '}
      <a href={`/courses/${encodeURIComponent(assignment.offeringId)}/assignments/${encodeURIComponent(assignment.id)}?view=history&scope=all#correction-authorizations`} target="_blank" rel="noopener noreferrer">检查或撤销授权 →</a>
    </p>}
    {status === 'CANCELLED' && <div className="form-field"><label htmlFor={`cancellation-${suffix}`}>取消原因</label><textarea id={`cancellation-${suffix}`} name="cancellationReason" maxLength={2000} rows={3} required defaultValue={assignment.cancellationReason ?? ''}/></div>}
  </fieldset>;
}
