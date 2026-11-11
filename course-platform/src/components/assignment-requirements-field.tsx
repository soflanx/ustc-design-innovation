'use client';

import { useId, useState } from 'react';
import { assignmentMaterialLink, splitAssignmentMaterialLinks } from '@/lib/assignment-material-links';
import styles from './course-page-record-dialog.module.css';

export type AssignmentMaterial = { id: string; title: string; visibilityStatus?: string };

export function appendAssignmentMaterial(description: string, offeringId: string, material: AssignmentMaterial) {
  if (splitAssignmentMaterialLinks(description, offeringId).some(part => part.resourceId === material.id)) return description;
  const link = assignmentMaterialLink(offeringId, material);
  const updated = description ? description + '\n\n' + link : link;
  if (updated.length > 12000) throw new Error('作业要求连同资料链接最多 12000 字，请缩短正文后再引用。');
  if (!splitAssignmentMaterialLinks(updated, offeringId).some(part => part.resourceId === material.id)) throw new Error('无法在正文末尾插入资料。请检查代码块是否已结束。');
  return updated;
}

export function AssignmentRequirementsField({ description, offeringId, materials, onChange, id, rows = 6, includeDrafts = false }: {
  description: string; offeringId: string; materials: AssignmentMaterial[];
  onChange: (next: string) => void; id?: string; rows?: number; includeDrafts?: boolean;
}) {
  const fieldId = useId();
  const [error, setError] = useState('');
  const parts = splitAssignmentMaterialLinks(description, offeringId);
  const selected = new Map<string, string>();
  for (const part of parts) if (part.resourceId) {
    selected.set(part.resourceId, part.text);
  }
  // The picker appends standalone links. Keep hand-written inline links exactly where the author put them.
  let footerStart = description.length;
  let offset = description.length;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    offset -= (part.raw ?? part.text).length;
    if (part.resourceId) {
      if (offset > 0 && description[offset - 1] !== '\n') break;
      footerStart = offset;
    } else if (part.text.trim()) break;
  }
  const prose = footerStart === description.length ? description : description.slice(0, footerStart).replace(/\r?\n(?:\r?\n)?$/, '');
  const suffix = description.slice(prose.length);
  const available = materials.filter(material => !selected.has(material.id));

  function update(next: string) {
    if (next.length > 12000) { setError('作业要求连同资料链接最多 12000 字。'); return; }
    setError('');
    onChange(next);
  }
  function remove(id: string) {
    let offset = 0;
    let next = '';
    for (const part of parts) {
      const raw = part.raw ?? part.text;
      if (part.resourceId !== id) next += raw;
      else if (offset >= footerStart) next = next.replace(/\r?\n(?:\r?\n)?$/, '');
      offset += raw.length;
    }
    update(next);
  }

  return <>
    <div className="form-field">
      <label htmlFor={id ?? fieldId}>作业要求</label>
      <textarea id={id ?? fieldId} name={suffix ? undefined : 'description'} rows={rows} maxLength={12000}
        value={prose} onChange={event => {
          const text = event.target.value;
          update(suffix ? text + (text ? '\n\n' : '') + description.slice(footerStart) : text);
        }} placeholder="学生要做什么、提交什么，以及如何评价"/>
      {suffix && <input type="hidden" name="description" value={description}/>}
    </div>
    {selected.size > 0 && <ul className={styles.materialList} aria-label="作业引用的资料">
      {[...selected].map(([id, title]) => <li key={id}><span>{title}</span>
        <button type="button" className="link-button" aria-label={`移除资料：${title}`} onClick={() => remove(id)}>移除</button></li>)}
    </ul>}
    {available.length > 0 && <label className="form-field">引用课程资料
      <select value="" onChange={event => {
        const material = available.find(item => item.id === event.target.value);
        if (material) {
          try { update(appendAssignmentMaterial(description, offeringId, material)); }
          catch (issue) { setError(issue instanceof Error ? issue.message : '暂时无法引用资料。'); }
        }
      }}><option value="">{includeDrafts ? '选择资料' : '选择已发布资料'}</option>
        {available.map(material => <option key={material.id} value={material.id}>{material.title}{material.visibilityStatus === 'DRAFT' ? '（草稿）' : ''}</option>)}</select>
    </label>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </>;
}
