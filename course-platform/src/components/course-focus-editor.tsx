'use client';

import { useId, useState } from 'react';
import { ActionForm } from './action-form';
import { saveCourseFocusAction } from '@/lib/course-focus-actions';
import styles from './course-focus-editor.module.css';

type Focus = {
  title: string;
  body: string;
  assignmentIds: string[];
  resourceIds: string[];
};

type RelatedItem = { id: string; title: string; status: string };

export type CourseFocusEditorProps = {
  offeringId: string;
  focus: Focus | null;
  assignments: RelatedItem[];
  resources: RelatedItem[];
};

function itemStatus(status: string, kind: 'assignment' | 'resource') {
  if (status === 'DRAFT') return '草稿';
  if (status === 'PUBLISHED') return '已发布';
  if (status === 'ARCHIVED') return kind === 'assignment' ? '已结束' : '已下架';
  return status;
}

export function CourseFocusEditor({ offeringId, focus, assignments, resources }: CourseFocusEditorProps) {
  const id = useId();
  const [open, setOpen] = useState(!focus);
  // Refresh saved defaults without discarding edits on a failed submission.
  const savedValuesKey = JSON.stringify([
    focus?.title ?? '', focus?.body ?? '',
    focus?.assignmentIds ?? [], focus?.resourceIds ?? [], assignments, resources,
  ]);

  return <section className={styles.editor} aria-label="编辑当前教学内容">
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>编辑当前教学内容</summary>
      <div className={styles.content}>
        <ActionForm action={saveCourseFocusAction.bind(null, offeringId)} submitLabel="保存教学内容" className={styles.form}>
          <fieldset key={savedValuesKey} className={styles.fields}>
            <div className="form-field">
              <label htmlFor={`${id}-title`}>当前在做什么</label>
              <input id={`${id}-title`} name="title" type="text" required maxLength={100} defaultValue={focus?.title ?? ''}/>
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-body`}>教学内容与本次要求</label>
              <textarea id={`${id}-body`} name="body" maxLength={12000} rows={8} defaultValue={focus?.body ?? ''}/>
            </div>
            <div className={styles.related}>
              <p id={`${id}-visibility`} className={styles.help}>按需关联本次作业和资料。学生可查看已发布或已结束的作业；草稿作业、未发布或下架资料不会显示。</p>
              <fieldset className={styles.options} aria-describedby={`${id}-visibility`}>
                <legend>关联本次作业</legend>
                {assignments.length ? <div className={styles.choices}>{assignments.map(assignment => <label className={styles.choice} key={assignment.id}>
                  <input type="checkbox" name="assignmentIds" value={assignment.id} defaultChecked={focus?.assignmentIds.includes(assignment.id) ?? false}/>
                  <span>{assignment.title}<small>{itemStatus(assignment.status, 'assignment')}</small></span>
                </label>)}</div> : <p className={styles.empty}>尚无可关联的作业。</p>}
              </fieldset>
              <fieldset className={styles.options} aria-describedby={`${id}-visibility`}>
                <legend>关联本次资料</legend>
                {resources.length ? <div className={styles.choices}>{resources.map(resource => <label className={styles.choice} key={resource.id}>
                  <input type="checkbox" name="resourceIds" value={resource.id} defaultChecked={focus?.resourceIds.includes(resource.id) ?? false}/>
                  <span>{resource.title}<small>{itemStatus(resource.status, 'resource')}</small></span>
                </label>)}</div> : <p className={styles.empty}>尚无可关联的资料。</p>}
              </fieldset>
            </div>
          </fieldset>
        </ActionForm>
      </div>
    </details>
  </section>;
}
