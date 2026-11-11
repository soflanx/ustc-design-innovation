'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { MAX_RESOURCE_FILE_BYTES } from '@/lib/resource-file-limits';
import { createResourceAction, updateResourceAction, type ResourceEditState } from '@/lib/resource-actions';

export type ResourceContentValues = { title: string; body: string; url: string; file?: File };
type ExistingSource = { url: string | null; file?: { name: string; size: number } | null };
type ResourceValues = ExistingSource & { id: string; title: string; body: string; status: string; revision: number };

type ResourceDraft = { baseline?: ResourceValues; values: ResourceContentValues; status: string; linkMode: boolean };

function initialDraft(resource?: ResourceValues): ResourceDraft {
  return {
    baseline: resource,
    values: { title: resource?.title ?? '', body: resource?.body ?? '', url: resource?.url ?? '' },
    status: resource?.status ?? 'DRAFT', linkMode: !!resource?.url,
  };
}

function hasChanges({ baseline, values, status, linkMode }: ResourceDraft) {
  return !!values.file || values.title !== (baseline?.title ?? '') || values.body !== (baseline?.body ?? '')
    || values.url !== (baseline?.url ?? '') || status !== (baseline?.status ?? 'DRAFT')
    || (!!baseline && linkMode !== !!baseline.url);
}

// Standalone edit drafts live only in this document's JS context, across client history navigation.
const editDrafts = new Map<string, ResourceDraft>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function storeDraft(key: string, draft: ResourceDraft | null) {
  if (draft) editDrafts.set(key, draft);
  else editDrafts.delete(key);
  for (const listener of listeners) listener();
}
const noDraft = () => null;

export function ResourceContentFields({ values, original, selectedLinkMode, onChange }: {
  values: ResourceContentValues;
  original?: ExistingSource;
  selectedLinkMode?: boolean;
  onChange: (patch: Partial<ResourceContentValues>, linkMode?: boolean) => void;
}) {
  const [localLinkMode, setLocalLinkMode] = useState(!!original?.url);
  const linkMode = selectedLinkMode ?? localLinkMode;
  const [fileError, setFileError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileOutsideInput, setFileOutsideInput] = useState(false);
  const legacy = !!original && !original.url && !original.file;
  useEffect(() => {
    const input = inputRef.current;
    const file = values.file;
    if (!input || !file) {
      if (input && !file) input.value = '';
      setFileOutsideInput(false);
      return;
    }
    if (input.files?.[0] !== file) {
      try {
        const selection = new DataTransfer();
        selection.items.add(file);
        input.files = selection.files;
      } catch { /* The form can submit the retained File directly. */ }
    }
    setFileOutsideInput(!input.files?.length);
  }, [values.file, linkMode]);
  function switchSource() {
    setFileError('');
    onChange({ url: linkMode ? '' : original?.url || '', file: undefined }, !linkMode);
    if (selectedLinkMode === undefined) setLocalLinkMode(!linkMode);
  }
  return <>
    <div>
      {linkMode ? <label className="form-field">在线资料链接
        <input name="url" type="url" required maxLength={2000} placeholder="https://" value={values.url} onChange={event => onChange({ url: event.target.value })}/>
      </label> : <label className="form-field">{original?.file ? '更换文件' : '资料文件'}
        {original?.file && <small>当前文件：{original.file.name}</small>}
        <input ref={inputRef} name="file" type="file" required={!original?.file && !legacy && !values.file} onChange={event => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          const issue = file && file.size > MAX_RESOURCE_FILE_BYTES ? '文件超过 10 MiB，请选择较小的文件。' : '';
          setFileError(issue);
          input.setCustomValidity(issue);
          if (issue) {
            input.value = '';
            onChange({ file: undefined });
            return;
          }
          const autoTitle = file && (!values.title.trim() || values.title === values.file?.name.slice(0, 100));
          onChange({ file, ...(autoTitle ? { title: file.name.slice(0, 100) } : {}) });
        }}/>
        {fileOutsideInput && values.file && <small>待保存的文件：{values.file.name}</small>}
        <small>{legacy ? '当前为旧版文字资料，可保留文字或选择文件替换。' : '单个文件最大 10 MiB。'}</small>
      </label>}
      {fileError && <p className="notice error" role="alert">{fileError}</p>}
      <button type="button" className="link-button" onClick={switchSource}>{linkMode ? '改为上传文件' : '使用在线链接'}</button>
    </div>
    <label className="form-field">资料标题
      <input name="title" required maxLength={100} value={values.title} onChange={event => onChange({ title: event.target.value })}/>
    </label>
    <label className="form-field">{legacy ? '原有资料文字' : '资料说明（选填）'}
      <textarea name="body" rows={legacy ? 5 : 2} maxLength={12000} value={values.body} onChange={event => onChange({ body: event.target.value })}/>
    </label>
  </>;
}

type ResourceFormProps = { offeringId: string; search?: string } & (
  { resource: ResourceValues; userId: string } | { resource?: undefined; userId?: undefined }
);

export function ResourceForm({ offeringId, resource, userId, search = '' }: ResourceFormProps) {
  const router = useRouter();
  const key = resource ? JSON.stringify([userId, offeringId, resource.id]) : null;
  const stored = useSyncExternalStore(subscribe, () => key ? editDrafts.get(key) ?? null : null, noDraft);
  const [creation, setCreation] = useState(() => initialDraft());
  const draft = resource ? stored ?? initialDraft(resource) : creation;
  const { values, status, baseline, linkMode } = draft;
  const dirty = hasChanges(draft);
  const conflict = !!resource && !!baseline && resource.revision !== baseline.revision;
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const busy = useRef(false);
  const requestId = useRef<string | null>(null);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const protectEdit = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin || (destination.pathname === window.location.pathname && destination.search === window.location.search)) return;
      if (!window.confirm('资料有未保存的修改。放弃修改并离开吗？')) {
        event.preventDefault();
        event.stopPropagation();
      } else if (key) {
        storeDraft(key, null);
      }
    };
    window.addEventListener('beforeunload', protect);
    // The standalone editor's return link and course navigation use the client router.
    // The creation form shares a list page with native file download links.
    if (resource) document.addEventListener('click', protectEdit, true);
    return () => {
      window.removeEventListener('beforeunload', protect);
      document.removeEventListener('click', protectEdit, true);
    };
  }, [dirty, resource, key]);
  function change(update: (current: ResourceDraft) => ResourceDraft) {
    if (key) {
      const next = update(editDrafts.get(key) ?? initialDraft(resource));
      storeDraft(key, hasChanges(next) ? next : null);
    } else setCreation(update);
    setError('');
  }

  return <form className="stack" onSubmit={async event => {
    event.preventDefault();
    if (busy.current || conflict) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    // An empty native file input can acquire a filename during multipart serialization.
    // Only a file the teacher selected should replace the saved material.
    if (values.file) data.set('file', values.file, values.file.name);
    else data.delete('file');
    if (resource) {
      data.set('expectedRevision', String(baseline!.revision));
      data.set('expectedUserId', userId);
    } else {
      requestId.current ??= crypto.randomUUID();
      data.set('requestId', requestId.current);
    }
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const result: ResourceEditState = resource
        ? await updateResourceAction(offeringId, resource.id, {}, data)
        : await createResourceAction(offeringId, {}, data);
      if (result.error) {
        setError(result.error);
        if (result.revisionConflict && form.isConnected) router.refresh();
        return;
      }
      if (key) {
        // An earlier request must not clear edits made after leaving and reopening this form.
        if (editDrafts.get(key) !== (stored ?? undefined)) return;
        storeDraft(key, null);
      } else {
        requestId.current = null;
        setCreation(initialDraft());
        setResetKey(key => key + 1);
        const details = form.closest('details');
        if (details) details.open = false;
      }
      if (!form.isConnected) return;
      const searchQuery = resource && search ? '?' + new URLSearchParams({ q: search }) : '';
      router.push('/courses/' + encodeURIComponent(offeringId) + '/resources' + searchQuery);
      router.refresh();
    } catch {
      setError('暂时无法保存，已保留表单内容，请重试。');
    } finally {
      busy.current = false;
      setPending(false);
    }
  }}>
    {conflict && <div className="notice" role="status">
      <p>这份草稿基于第 {baseline.revision} 版，资料已更新到第 {resource.revision} 版。</p>
      <a href={`/courses/${encodeURIComponent(offeringId)}/resources/${encodeURIComponent(resource.id)}?edit=1`} target="_blank" rel="noopener noreferrer">在新标签页查看最新版</a>
    </div>}
    <fieldset disabled={pending} className="stack" style={{ border: 0, margin: 0, padding: 0 }}>
      <ResourceContentFields key={resetKey} values={values} original={baseline} selectedLinkMode={linkMode}
        onChange={(patch, mode) => change(current => ({ ...current, values: { ...current.values, ...patch }, linkMode: mode ?? current.linkMode }))}/>
      <label className="form-field">发布状态
        <select name="status" value={status} onChange={event => {
          const status = event.target.value;
          change(current => ({ ...current, status }));
        }}>
          <option value="DRAFT">草稿</option><option value="PUBLISHED">已发布</option>{resource && <option value="ARCHIVED">已撤回</option>}
        </select>
      </label>
    </fieldset>
    {error && <p className="notice error" role="alert">{error}</p>}
    <div><button className="button primary" type="submit" disabled={pending || conflict}>{pending ? '正在保存…' : resource ? '保存修改' : status === 'PUBLISHED' ? '发布资料' : '保存草稿'}</button>
      {key && dirty && <button className="link-button" type="button" disabled={pending} onClick={() => {
        if (!window.confirm('放弃这份未保存的资料修改吗？')) return;
        storeDraft(key, null);
        setError('');
        setResetKey(value => value + 1);
        if (conflict) router.refresh();
      }}>{conflict ? '放弃本稿并载入最新版' : '放弃修改'}</button>}
    </div>
  </form>;
}
