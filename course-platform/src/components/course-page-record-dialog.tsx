'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { CourseDocumentRecord } from '@/lib/course-document-view';
import { courseRecordSaveImpact } from '@/lib/course-publication';
import { ResourceContentFields, type ResourceContentValues } from './resource-fields';
import { AssignmentRequirementsField, appendAssignmentMaterial, type AssignmentMaterial } from './assignment-requirements-field';
import { MAX_RESOURCE_FILE_BYTES } from '@/lib/resource-file-limits';
import styles from './course-page-record-dialog.module.css';

export type PageRecordRequest = { blockId: string; kind: 'assignments' | 'resources'; recordId?: string; afterBlockId?: string; standalone?: boolean };
export type PageRecordValues = ResourceContentValues & { description: string; mode: 'INDIVIDUAL' | 'GROUP'; dueAt: string; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'CANCELLED'; maxScore: number; cancellationReason: string };

export function CoursePageRecordDialog({ request, record, offeringId, materials, onSaveMaterial, pending, error, courseStatus, onCancel, onSave }: {
  request: PageRecordRequest; record?: CourseDocumentRecord; pending: boolean; error: string; courseStatus: string;
  offeringId: string; materials: AssignmentMaterial[]; onSaveMaterial: (file: File, requestId: string) => Promise<CourseDocumentRecord>;
  onCancel: () => void; onSave: (values: PageRecordValues) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const assignment = request.kind === 'assignments';
  const name = assignment ? '作业' : '资料';
  const creatingInPage = !request.recordId && !request.standalone;
  const original = assignment ? record?.assignment : record?.resource;
  const saveMaterialAsDraft = !request.standalone;
  const [values, setValues] = useState<PageRecordValues>({
    title: original?.title || '', description: record?.assignment?.description || '', mode: record?.assignment?.mode || 'INDIVIDUAL',
    dueAt: record?.assignment?.dueAt || '', body: record?.resource?.body || '', url: record?.resource?.url || '', status: original?.status || 'DRAFT',
    maxScore: record?.assignment?.maxScore ?? 100, cancellationReason: record?.assignment?.cancellationReason ?? '',
  });
  const initialValues = useRef(JSON.stringify(values));
  const [selectedFile, setSelectedFile] = useState<{ file: File; requestId: string; saved?: CourseDocumentRecord } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [savedFile, setSavedFile] = useState('');
  const [uploadError, setUploadError] = useState('');
  const uploadingRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = pending || uploading;
  const dirty = !!selectedFile || !!values.file || JSON.stringify(values) !== initialValues.current;
  const set = <K extends keyof PageRecordValues>(key: K, value: PageRecordValues[K]) => setValues(old => ({ ...old, [key]: value }));
  const pastDue = assignment && values.status === 'PUBLISHED' && values.dueAt && new Date(`${values.dueAt}:00+08:00`).getTime() <= Date.now();
  const label = creatingInPage ? `保存${name}草稿并加入正文` : values.status === 'DRAFT' ? `保存${name}草稿` : values.status === original?.status ? values.status === 'PUBLISHED' ? assignment ? '保存并更新要求' : '保存并更新资料' : '保存修改' : values.status === 'CANCELLED' ? '取消作业' : values.status === 'ARCHIVED' ? assignment ? '结束提交' : '撤回资料' : original?.status === 'CANCELLED' ? '恢复发布' : `发布${name}`;
  const impact = creatingInPage ? '保存后加入正文草稿。发布正文时可以选择一并发布。' : courseRecordSaveImpact(request.kind, values.status, original?.status);
  const draftFileNote = values.status === 'DRAFT'
    ? '已选文件，随作业草稿保存并加入要求。学生暂时看不到。'
    : '已选文件，保存作业时会保留为资料草稿并加入要求。资料发布后学生才能打开。';
  const outcome = assignment && values.status === 'PUBLISHED'
      ? courseStatus === 'DRAFT' ? '课程仍在筹备：学生可阅读，开课后才能提交。'
        : pastDue ? '已过截止时间：学生可阅读，但不能提交。' : ''
      : '';
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLInputElement>('input:not([type="hidden"])')?.focus();
    return () => { if (element?.open) element.close(); };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [dirty]);
  function cancel() {
    if (!busy && (!dirty || window.confirm(`放弃尚未保存的${name}修改？${savedFile ? '已保存的文件仍保存在课程资料中。' : ''}`))) onCancel();
  }
  function clearFile() {
    if (fileInput.current) fileInput.current.value = '';
    setSelectedFile(null);
    setUploadError('');
  }
  async function saveFile() {
    if (!selectedFile || busy || uploadingRef.current || selectedFile.file.size > MAX_RESOURCE_FILE_BYTES) return;
    uploadingRef.current = true;
    setUploading(true);
    setUploadError('');
    try {
      const material = selectedFile.saved ?? await onSaveMaterial(selectedFile.file, selectedFile.requestId);
      if (material.visibilityStatus !== (saveMaterialAsDraft ? 'DRAFT' : 'PUBLISHED')) throw new Error('这份资料的发布状态已改变，请重新核对。');
      setSavedFile(material.title);
      // A full description or an unfinished code block can still prevent inserting the link.
      // Keep the returned resource so the teacher can correct the text and retry the attachment.
      setSelectedFile({ ...selectedFile, saved: material });
      const description = appendAssignmentMaterial(values.description, offeringId, material);
      set('description', description);
      clearFile();
      return description;
    } catch (issue) {
      setUploadError(issue instanceof Error ? issue.message : '暂未确认资料保存结果，请重试。');
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || uploadingRef.current) return;
    if (!selectedFile) { onSave(values); return; }
    if (!saveMaterialAsDraft) return;
    const description = await saveFile();
    if (description !== undefined) onSave({ ...values, description });
  }
  return createPortal(<dialog ref={dialog} className={styles.dialog} aria-labelledby="course-record-dialog-title" onCancel={event => { event.preventDefault(); cancel(); }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) cancel(); } }}>
    <form onSubmit={submit}>
      <header className={styles.header}><h2 id="course-record-dialog-title">{request.recordId ? `编辑${name}` : `新建${name}`}</h2><button type="button" disabled={busy} aria-label="关闭记录编辑" onClick={cancel}>×</button></header>
      <div className={styles.content}>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <fieldset disabled={busy} className={styles.fields}>
          {assignment ? <>
            <label>{name}标题<input autoFocus name="title" required maxLength={100} value={values.title} onChange={event => set('title', event.target.value)}/></label>
            <AssignmentRequirementsField offeringId={offeringId} description={values.description} materials={materials} includeDrafts={!request.standalone} onChange={value => set('description', value)}/>
            <div className={styles.materialUpload}>
              <label>上传配套文件<input type="file" ref={fileInput} onChange={event => {
                const file = event.currentTarget.files?.[0];
                setSelectedFile(file ? { file, requestId: crypto.randomUUID() } : null);
                setUploadError(file && file.size > MAX_RESOURCE_FILE_BYTES ? '文件超过 10 MiB，请选择较小的文件。' : '');
              }}/></label>
              {selectedFile && <>
                {!selectedFile.saved && <p className={styles.outcome}>{saveMaterialAsDraft ? draftFileNote : '文件发布后本期学生可从课程资料打开。发布并引用或移除此文件后，即可保存作业。'}</p>}
                <div className="inline-actions">
                  {!saveMaterialAsDraft && <button type="button" className="button secondary" disabled={selectedFile.file.size > MAX_RESOURCE_FILE_BYTES} onClick={saveFile}>{uploading ? '正在处理…' : selectedFile.saved ? '引用已保存文件' : '发布资料并引用'}</button>}
                  <button type="button" className="link-button" onClick={clearFile}>移除此文件</button>
                </div>
              </>}
              {savedFile && <p className={styles.outcome} role="status">“{savedFile}”{saveMaterialAsDraft ? '已保存为资料草稿。' : '已发布到课程资料。'}放弃本次作业修改也会保留该文件。</p>}
              {uploadError && <p className={styles.error} role="alert">{uploadError}</p>}
            </div>
            <div className={styles.grid}>
              <label>提交方式<select name="mode" disabled={!!record?.assignment?.versionCount} value={values.mode} onChange={event => set('mode', event.target.value as PageRecordValues['mode'])}><option value="INDIVIDUAL">每位学生单独提交</option><option value="GROUP">每个小组共同提交</option></select>{!!record?.assignment?.versionCount && <small>已有提交，提交方式保持不变。</small>}</label>
              <label>提交截止（北京时间，选填）<input name="dueAt" type="datetime-local" title="不填则不设截止时间" value={values.dueAt} onChange={event => set('dueAt', event.target.value)}/></label>
            </div>
          </> : <ResourceContentFields values={values} original={record?.resource} onChange={patch => setValues(previous => ({ ...previous, ...patch }))}/>}
          {!creatingInPage && <label>发布状态<select name="status" value={values.status} onChange={event => set('status', event.target.value as PageRecordValues['status'])}>
            {(!assignment || !original || original.status === 'DRAFT') && <option value="DRAFT">草稿 · 学生不可见</option>}
            <option value="PUBLISHED">{original?.status === 'CANCELLED' ? '恢复发布 · 重新要求完成' : '发布 · 学生可见'}</option>
            {request.recordId && (!assignment || (original?.status !== 'DRAFT' && original?.status !== 'CANCELLED')) && <option value="ARCHIVED">{assignment ? '结束提交 · 保留查看与反馈' : '撤回 · 学生不可见'}</option>}
            {assignment && request.recordId && original?.status !== 'DRAFT' && <option value="CANCELLED">取消 · 学生免交，保留历史</option>}
          </select></label>}
          {assignment && values.status === 'CANCELLED' && <label>取消原因<textarea name="cancellationReason" rows={3} required maxLength={2000} value={values.cancellationReason} onChange={event => set('cancellationReason', event.target.value)}/></label>}
          {outcome && <p className={styles.outcome} role="status">{outcome}</p>}
        </fieldset>
      </div>
      <footer className={styles.footer}><p id="course-record-save-impact" className={styles.saveImpact} role="status">{impact}</p><button type="button" disabled={busy} onClick={cancel}>取消</button><button type="submit" disabled={busy || (!!selectedFile && (!saveMaterialAsDraft || selectedFile.file.size > MAX_RESOURCE_FILE_BYTES))} className={styles.primary} aria-describedby="course-record-save-impact">{busy ? '正在保存…' : label}</button></footer>
    </form>
  </dialog>, document.body);
}
