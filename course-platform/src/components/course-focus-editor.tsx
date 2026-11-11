'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { saveAuthoredPageAction, withdrawAuthoredPageAction } from '@/lib/course-authored-page-actions';
import { CourseMarkdownEditor } from './course-markdown-editor';
import { CourseContentIcon } from './course-content-icon';
import { saveCoursePageAssignmentAction, saveCoursePageResourceAction } from '@/lib/course-page-record-actions';
import { courseDocumentTitle, courseTitleBlock, ensureCoursePageTitle, retainCourseTitleReference, type CourseBlock, type CourseDocument } from '@/lib/course-document';
import type { CourseAuthoredSnapshot } from '@/lib/course-authored-page';
import type { CourseDocumentCatalog, CourseDocumentRecord } from '@/lib/course-document-view';
import { courseStudentPreview } from '@/lib/course-student-preview';
import { assignmentLifecycle } from '@/lib/teaching-presentation';
import type { CoursePublicationPlan } from '@/lib/course-publication-plan';
import { applyCoursePublicationPlanAction, previewCoursePublicationPlanAction } from '@/lib/course-publication-plan-actions';
import { CourseDocumentView } from './course-document-view';
import type { CourseBlockEditorHandle } from './course-block-editor';
import { CoursePageRecordDialog, type PageRecordRequest, type PageRecordValues } from './course-page-record-dialog';
import styles from './course-focus-editor.module.css';

const CourseBlockEditor = dynamic(() => import('./course-block-editor'), {
  ssr: false,
  loading: () => <p className={styles.help} role="status">正在准备编辑器…</p>,
});

export type CourseEditorIntent = 'edit' | 'create-assignment';
export type CourseFocusEditorProps = { authorId: string; offeringId: string; focus: CourseAuthoredSnapshot | null; catalog: CourseDocumentCatalog; canManageRecords?: boolean; courseStatus?: string; subpageId?: string; initialIntent?: CourseEditorIntent };

function blankDocument(): CourseDocument {
  return { version: 1, blocks: [] };
}
const recordRevision = (record: CourseDocumentRecord) => record.assignment?.revision ?? record.resource?.revision ?? 0;

function PageOptions({ children }: { children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function dismiss(event: PointerEvent) {
      if (details.current?.open && event.target instanceof Node && !details.current.contains(event.target)) details.current.open = false;
    }
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  return <details className={styles.options} ref={details}
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}
    onKeyDown={event => {
      if (event.key === 'Escape' && event.currentTarget.open) {
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }
    }}
    onClick={event => {
      if (event.target instanceof Element && event.target.closest('button')) {
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus({ preventScroll: true });
      }
    }}>
    <summary aria-label="更多页面操作" title="更多页面操作"><CourseContentIcon name="more" size={20}/></summary>
    <div className={styles.optionList}>{children}</div>
  </details>;
}

function requiresPublicationReview(plan: CoursePublicationPlan) {
  return plan.hasProtectedReferences || plan.records.some(record =>
    record.status === 'DRAFT' || (record.kind === 'resources' && record.status === 'ARCHIVED'));
}

function publicationOutcome(record: CoursePublicationPlan['records'][number], selected: boolean) {
  if (record.status === 'DRAFT') {
    if (selected) return record.kind === 'assignments' ? '学生可从作业目录打开。' : '学生可从课程资料打开。';
    return '保持草稿，学生暂时看不到。';
  }
  if (record.status === 'CANCELLED') return '学生仍可查看，作业免交。';
  if (record.status === 'ARCHIVED') return record.kind === 'assignments' ? '学生仍可查看，已停止提交。' : '已撤回，学生看不到。';
  if (record.kind === 'resources' && record.source === 'assignment') return '学生可从课程资料打开。';
  if (record.kind === 'pages') return '发布后学生可从课程首页打开。';
  return '发布后学生可从正文打开。';
}

export function CourseFocusEditor({ authorId, offeringId, focus, catalog, canManageRecords = false, courseStatus = 'ACTIVE', subpageId, initialIntent }: CourseFocusEditorProps) {
  const router = useRouter();
  const pageRef = useRef<HTMLDivElement>(null);
  const writingSelection = useRef<{ start: number; end: number; scrollTop: number } | null>(null);
  const returnToWriting = useRef(false);
  const titleBlockId = useRef<string | null>(null);
  const editorHandle = useRef<CourseBlockEditorHandle | null>(null);
  const documentRef = useRef<CourseDocument | null>(null);
  const operationPending = useRef(false);
  const publicationHeading = useRef<HTMLHeadingElement>(null);
  const latestFocus = useRef(focus);
  if ((focus?.revision ?? 0) >= (latestFocus.current?.revision ?? 0)) latestFocus.current = focus;
  const [open, setOpen] = useState(false);
  const [document, setDocument] = useState<CourseDocument | null>(null);
  const [revision, setRevision] = useState(0);
  const [baseline, setBaseline] = useState('');
  const [hasDraft, setHasDraft] = useState(!!focus?.draft);
  const [mode, setMode] = useState<'write' | 'layout'>('write');
  const [preview, setPreview] = useState(false);
  const [pending, setPending] = useState(false);
  const [checkingPublication, setCheckingPublication] = useState(false);
  const [publicationReview, setPublicationReview] = useState<{ plan: CoursePublicationPlan; selected: string[]; changed: boolean } | null>(null);
  const [reviewedAssignments, setReviewedAssignments] = useState<CoursePublicationPlan['records']>([]);
  const [discard, setDiscard] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [session, setSession] = useState(0);
  const [recordRequest, setRecordRequest] = useState<PageRecordRequest | null>(null);
  const [recordSnapshot, setRecordSnapshot] = useState<CourseDocumentRecord>();
  const [recordError, setRecordError] = useState('');
  const [savedRecords, setSavedRecords] = useState<Partial<Record<'assignments' | 'resources', CourseDocumentRecord[]>>>({});
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const dirty = open && JSON.stringify(document) !== baseline;
  const pageName = subpageId ? '课次' : '课程首页';
  const onEditorReady = useCallback((handle: CourseBlockEditorHandle | null) => { editorHandle.current = handle; }, []);
  const liveCatalog: CourseDocumentCatalog = { ...catalog };
  for (const kind of ['assignments', 'resources'] as const) {
    const records = new Map(catalog[kind].map(record => [record.id, record]));
    for (const record of savedRecords[kind] ?? []) {
      if (!records.has(record.id) || recordRevision(record) >= recordRevision(records.get(record.id)!)) records.set(record.id, record);
    }
    liveCatalog[kind] = [...records.values()];
  }
  if (reviewedAssignments.length) {
    const latestAssignments = new Map(reviewedAssignments.map(record => [record.id, record]));
    liveCatalog.assignments = liveCatalog.assignments.map(previous => {
      const record = latestAssignments.get(previous.id);
      if (!record || record.revision < recordRevision(previous)) return previous;
      const lifecycle = assignmentLifecycle({ status: record.status, dueAt: record.deadline ? new Date(record.deadline) : null },
        courseStatus === 'DRAFT' || courseStatus === 'ARCHIVED' ? courseStatus : 'ACTIVE', new Date());
      return { ...previous, title: record.title, deadline: record.deadline ?? undefined, assignmentMode: record.assignmentMode,
        visibilityStatus: record.status, status: lifecycle.lifecycleLabel, ...lifecycle };
    });
  }
  const selectedKeys = new Set(publicationReview?.selected);
  const previewCatalog = publicationReview && preview ? {
    ...liveCatalog,
    ...Object.fromEntries((['assignments', 'resources', 'pages'] as const).map(kind => {
      const existing = new Map(liveCatalog[kind]?.map(record => [record.id, record]));
      // The plan is the current read boundary. A protected reference omitted
      // by the server must not remain visible through an older catalog entry.
      const records = publicationReview.plan.records.filter(record => record.kind === kind).map((record): CourseDocumentRecord => {
        const previous = existing.get(record.id);
        const visibilityStatus = record.selectable && selectedKeys.has(record.key) ? 'PUBLISHED' : record.status;
        const lifecycle = kind === 'assignments'
          ? assignmentLifecycle({ status: visibilityStatus, dueAt: record.deadline ? new Date(record.deadline) : null },
            courseStatus === 'DRAFT' || courseStatus === 'ARCHIVED' ? courseStatus : 'ACTIVE', new Date())
          : { lifecycleLabel: previous?.lifecycleLabel, lifecycleHint: previous?.lifecycleHint };
        return {
          ...previous,
          id: record.id,
          title: record.title,
          href: previous?.href ?? `/courses/${encodeURIComponent(offeringId)}/${kind}/${encodeURIComponent(record.id)}`,
          visibilityStatus,
          ...(kind === 'assignments' ? { deadline: record.deadline ?? undefined, assignmentMode: record.assignmentMode } : {}),
          ...lifecycle,
        };
      });
      return [kind, records];
    })),
  } : liveCatalog;
  const studentPreview = preview && document ? courseStudentPreview(document, previewCatalog) : null;
  const pageTitle = document && courseTitleBlock(document)?.content?.map(part => part.type === 'text' ? part.text : part.content.map(span => span.text).join('')).join('');

  useEffect(() => {
    if (!open || !pageRef.current) return;
    const top = pageRef.current.getBoundingClientRect().top;
    if (top < 0 || top >= window.innerHeight) pageRef.current.scrollIntoView({ block: 'start' });
  }, [open]);
  useEffect(() => { if (publicationReview) publicationHeading.current?.focus(); }, [publicationReview]);
  useLayoutEffect(() => {
    if (preview || pending || !returnToWriting.current) return;
    const source = pageRef.current?.querySelector<HTMLTextAreaElement>('textarea[data-writing-area]');
    returnToWriting.current = false;
    if (!source || source.disabled) return;
    source.focus({ preventScroll: true });
    const selection = writingSelection.current;
    if (selection) {
      source.setSelectionRange(selection.start, selection.end);
      source.scrollTop = selection.scrollTop;
    }
  }, [preview, pending]);
  useEffect(() => { setPublicationReview(null); setReviewedAssignments([]); }, [catalog]);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const navigate = (event: MouseEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || anchor.target === '_blank' || anchor.download || anchor.href === window.location.href || anchor.closest('[data-student-preview]')) return;
      if (!window.confirm('页面还有未保存的修改。离开后这些修改将丢失，仍要离开吗？')) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener('beforeunload', unload);
    window.document.addEventListener('click', navigate, true);
    return () => { window.removeEventListener('beforeunload', unload); window.document.removeEventListener('click', navigate, true); };
  }, [dirty]);

  function updateDocument(next: CourseDocument) {
    documentRef.current = next; setDocument(next); setPublicationReview(null);
  }
  function rememberAssignmentPlan(plan: CoursePublicationPlan) {
    setReviewedAssignments(previous => {
      const records = new Map(previous.map(record => [record.id, record]));
      for (const record of plan.records) if (record.kind === 'assignments') records.set(record.id, record);
      return [...records.values()];
    });
  }
  function changePreview(next: boolean) {
    const field = pageRef.current?.querySelector<HTMLTextAreaElement>('textarea[data-writing-area]');
    if (next && field) writingSelection.current = { start: field.selectionStart, end: field.selectionEnd, scrollTop: field.scrollTop };
    returnToWriting.current = !next;
    setPreview(next);
  }
  function updateTitle(value: string) {
    if (!document) return;
    const next = courseTitleBlock(document) ? document : ensureCoursePageTitle({ ...document, titleBlockId: undefined }, '');
    const replace = (items: CourseBlock[]): CourseBlock[] => items.map(block => block.id === next.titleBlockId
      ? { ...block, content: [{ type: 'text', text: value, styles: {} }] }
      : block.children?.length ? { ...block, children: replace(block.children) } : block);
    titleBlockId.current = next.titleBlockId ?? null;
    updateDocument({ ...next, blocks: replace(next.blocks) });
  }
  useEffect(() => {
    if (!initialIntent) return;
    const url = new URL(window.location.href);
    if (initialIntent === 'create-assignment') {
      if (url.searchParams.get('create') !== 'assignment') return;
      startAssignment();
      url.searchParams.delete('create');
    } else if (url.searchParams.get('edit') === '1') {
      if (!open) startEditing();
    } else return;
    if (url.searchParams.get('edit') === '1') url.searchParams.delete('edit');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, [initialIntent]);
  function startEditing() {
    const current = latestFocus.current;
    const nextDocument = ensureCoursePageTitle(current?.draft?.document ?? current?.document ?? blankDocument(), current?.draft?.title ?? current?.title ?? (subpageId ? '' : '课程说明'));
    titleBlockId.current = nextDocument.titleBlockId ?? null;
    documentRef.current = nextDocument;
    setDocument(nextDocument); setRevision(current?.revision ?? 0); setHasDraft(!!current?.draft);
    setBaseline(JSON.stringify(nextDocument));
    setSession(value => value + 1); setMode('write'); setOpen(true); setPreview(false); setDiscard(false); setError(''); setSuccess('');
    setRecordRequest(null); setRecordError(''); setPublicationReview(null);
  }
  function manageRecord(request: PageRecordRequest) {
    if (!canManageRecords || pending || operationPending.current) return;
    setRecordSnapshot(liveCatalog[request.kind].find(record => record.id === request.recordId));
    setRecordRequest(request); setRecordError(''); setSuccess(''); setPublicationReview(null);
  }
  function startAssignment() {
    if (subpageId || !canManageRecords || pending || operationPending.current) return;
    manageRecord({ blockId: crypto.randomUUID(), kind: 'assignments', standalone: true });
  }
  function rememberRecord(kind: PageRecordRequest['kind'], record: CourseDocumentRecord) {
    setSavedRecords(previous => ({ ...previous, [kind]: [...(previous[kind] ?? []).filter(item => item.id !== record.id), record] }));
  }
  async function saveAssignmentMaterial(file: File, requestId: string) {
    if (!canManageRecords || recordRequest?.kind !== 'assignments' || operationPending.current) throw new Error('当前无法保存资料。');
    operationPending.current = true;
    try {
      const upload = new FormData();
      upload.set('file', file, file.name);
      const result = await saveCoursePageResourceAction(offeringId, authorId, {
        requestId, resource: { title: file.name.slice(0, 100), body: '', url: '', status: recordRequest.standalone ? 'PUBLISHED' : 'DRAFT' },
      }, upload);
      if (!result.record) throw new Error(result.error || '资料未能保存，请重试。');
      rememberRecord('resources', result.record);
      return result.record;
    } finally {
      operationPending.current = false;
    }
  }
  async function saveRecord(values: PageRecordValues) {
    if (!recordRequest || pending || operationPending.current || !canManageRecords) return;
    const request = recordRequest;
    if (!request.recordId && !request.standalone && !editorHandle.current) {
      setRecordError('页面编辑器还在准备，请稍后再保存。');
      return;
    }
    const original = request.kind === 'assignments' ? recordSnapshot?.assignment : recordSnapshot?.resource;
    operationPending.current = true;
    setPending(true); setRecordError(''); setPublicationReview(null);
    try {
      const { title, description, mode, dueAt, status, body, url, file, maxScore, cancellationReason } = values;
      const assignmentOriginal = recordSnapshot?.assignment;
      const resourceOriginal = recordSnapshot?.resource;
      const statusOnly = !!request.recordId && (request.kind === 'assignments'
        ? !!assignmentOriginal && title === assignmentOriginal.title && description === assignmentOriginal.description && mode === assignmentOriginal.mode && dueAt === assignmentOriginal.dueAt && maxScore === assignmentOriginal.maxScore
        : !!resourceOriginal && !file && title === resourceOriginal.title && body === resourceOriginal.body && url === resourceOriginal.url);
      const common = { requestId: request.recordId ? undefined : request.blockId, expectedRevision: original?.revision, statusOnly };
      let upload: FormData | undefined;
      if (file) {
        upload = new FormData();
        upload.set('file', file, file.name);
      }
      const result = request.kind === 'assignments'
        ? await saveCoursePageAssignmentAction(offeringId, authorId, { ...common, assignment: { id: request.recordId, title, description, mode, dueAt, status, maxScore, cancellationReason } })
        : await saveCoursePageResourceAction(offeringId, authorId, { ...common, resource: { id: request.recordId, title, body, url, status: status as 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' } }, upload);
      if (result.error || !result.record) {
        setRecordError((result.error || '暂时无法保存，请重试。') + (result.revisionConflict ? '关闭此窗口再打开可读取最新版，页面修改会保留。' : ''));
        if (result.revisionConflict) router.refresh();
        return;
      }
      const record = result.record;
      rememberRecord(request.kind, record);
      if (!request.recordId && !request.standalone) editorHandle.current?.insertRecord(request, record.id, record.title);
      setRecordRequest(null);
      const list = request.kind === 'assignments' ? '作业' : '课程资料';
      const name = request.kind === 'assignments' ? '作业' : '资料';
      const visibility = record.visibilityStatus === 'PUBLISHED'
        ? `学生可从“${list}”打开。教学安排中的新入口将在发布页面后显示。`
        : `可在发布${pageName}时选择一并发布${name}。`;
      setSuccess(request.recordId || request.standalone ? result.success : result.success + visibility);
      router.refresh();
    } catch { setRecordError('暂时无法保存，表单和页面内容仍保留，请重试。'); }
    finally { operationPending.current = false; setPending(false); }
  }
  async function withdraw() {
    const current = latestFocus.current;
    const withdrawnContent = subpageId ? '这节课的内容' : '首页正文';
    if (!current?.publishedAt || operationPending.current || !window.confirm(`撤回后，学生将看不到${withdrawnContent}。教学团队仍可编辑草稿并再次发布。`)) return;
    operationPending.current = true; setPending(true); setError(''); setSuccess('');
    try {
      const result = await withdrawAuthoredPageAction(offeringId, subpageId ?? null, revision, authorId);
      if (!result.page) { setError(result.error || '未能撤回，请刷新后再试。'); return; }
      latestFocus.current = result.page;
      setHasDraft(true); setOpen(false); setSuccess('已撤回为草稿。'); router.refresh();
    } catch { setError('未能确认撤回结果，请刷新查看。'); }
    finally { operationPending.current = false; setPending(false); }
  }
  async function save(publish = false, confirmation?: { key: string; selected: string[] }) {
    if (!document || pending || operationPending.current || recordRequest) return;
    if (courseTitleBlock(document)) {
      const title = courseTitleBlock(document)?.content?.map(part => part.type === 'text' ? part.text : part.content.map(span => span.text).join('')).join('');
      if (!title?.trim()) { setError('请填写页面标题。'); return; }
    }
    const snapshot = document;
    const serialized = JSON.stringify(snapshot);
    operationPending.current = true;
    setPending(true); setError(''); setDiscard(false); setSuccess('');
    if (!publish) setPublicationReview(null);
    try {
      if (publish) setCheckingPublication(true);
      const input = { title: courseDocumentTitle(snapshot, latestFocus.current?.draft?.title ?? latestFocus.current?.title), document: snapshot, revision };
      let checked = confirmation;
      if (publish && !checked) {
        const result = await previewCoursePublicationPlanAction(offeringId, subpageId ?? null, input, authorId);
        if (!result.plan) { setError(result.error || '未能核对发布内容，请重试。'); return; }
        if (JSON.stringify(documentRef.current) !== serialized) {
          setPublicationReview(null); setError('正文已变化，请再次核对发布内容。'); return;
        }
        rememberAssignmentPlan(result.plan);
        if (requiresPublicationReview(result.plan)) {
          setPublicationReview({ plan: result.plan, selected: [], changed: false });
          return;
        }
        checked = { key: result.plan.key, selected: [] };
      }
      const result = checked
        ? await applyCoursePublicationPlanAction(offeringId, subpageId ?? null, input, authorId, checked.key, checked.selected)
        : await saveAuthoredPageAction(offeringId, subpageId ?? null, input, false, undefined, authorId);
      if ('plan' in result && result.plan) {
        if (JSON.stringify(documentRef.current) !== serialized) {
          setPublicationReview(null); setError('正文已变化，请再次核对发布内容。'); return;
        }
        rememberAssignmentPlan(result.plan);
        setPublicationReview({ plan: result.plan, selected: [], changed: true });
        return;
      }
      if (result.error || !('page' in result) || !result.page) { setError(result.error || '页面未保存，请重试。'); return; }
      setPublicationReview(null);
      latestFocus.current = result.page;
      setRevision(result.page.revision); setBaseline(serialized); setHasDraft(!publish);
      const editedDuringSave = JSON.stringify(documentRef.current) !== serialized;
      if (publish && !editedDuringSave) setOpen(false);
      const publishedRecords = confirmation?.selected.length ?? 0;
      setSuccess(publish
        ? `${pageName}已发布，学生可以阅读。${publishedRecords ? `本次一并发布 ${publishedRecords} 项作业或资料。` : ''}${editedDuringSave ? '随后编辑的内容尚未保存。' : ''}`
        : '草稿已保存。');
      router.refresh();
    } catch { setError('暂时无法保存，修改仍保留在编辑器中，请重试。'); }
    finally { operationPending.current = false; setCheckingPublication(false); setPending(false); }
  }

  return <section id="course-compose" className={styles.editor} aria-label="编辑页面正文" data-course-editing={open ? '' : undefined}>
    {!open ? <div className={styles.entry}>
      {latestFocus.current?.draft && <span className={styles.state}>有未发布草稿</span>}
      <div className={styles.entryActions}>
        <button type="button" className={styles.editButton} disabled={pending} onClick={startEditing}>{subpageId ? '编辑课次' : '编辑课程首页'}</button>
      </div>
      {error && <span className={styles.error} role="alert">{error}</span>}
      {success && <span className={styles.saved} role="status">{success}</span>}
    </div> : <div className={styles.panel} ref={pageRef} data-course-selection-surface onKeyDownCapture={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void save(); } }}>
      <div className={styles.toolbar} data-course-editor-toolbar>
        <div className={styles.toolbarLeft}>
          <span className={styles.state} data-dirty={dirty} role="status">{pending ? checkingPublication ? '核对中…' : '保存中…' : dirty ? '未保存' : hasDraft ? '草稿已保存' : latestFocus.current?.publishedAt ? '已发布' : '正文尚未发布'}</span>
          <div ref={setToolbarHost} className={styles.toolbarInsert} hidden={preview}/>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.quietButton} disabled={pending} aria-label={preview ? '继续编辑' : '学生预览'} aria-pressed={preview} aria-controls="course-student-preview" onClick={() => changePreview(!preview)}><span className={styles.qualifier}>{preview ? '继续' : '学生'}</span>{preview ? '编辑' : '预览'}</button>
          <button type="button" className={styles.quietButton} disabled={pending || (!dirty && hasDraft)} aria-label="保存草稿" title="仅教学团队可见；Cmd/Ctrl+S" onClick={() => save()}>保存<span className={styles.qualifier}>草稿</span></button>
          <button type="button" className={styles.saveButton} disabled={pending} onClick={() => save(true)}>{subpageId ? '发布课次' : '发布课程首页'}</button>
          <PageOptions>
            {!preview && <button type="button" aria-label={mode === 'write' ? '调整布局' : '返回写作'} disabled={pending} onClick={() => { setMode(mode === 'write' ? 'layout' : 'write'); setSession(value => value + 1); }}>{mode === 'write' ? '调整布局' : '返回写作'}</button>}
            {latestFocus.current?.publishedAt && <button type="button" disabled={pending || dirty} onClick={withdraw}>撤回为草稿</button>}
            <button type="button" aria-label="退出编辑" disabled={pending} onClick={() => { setPublicationReview(null); if (dirty) setDiscard(true); else setOpen(false); }}>退出编辑</button>
          </PageOptions>
        </div>
      </div>
      {publicationReview && <section className={styles.publicationReview} aria-labelledby="course-publication-heading" data-course-editor-toolbar>
        <h3 id="course-publication-heading" ref={publicationHeading} tabIndex={-1}>{publicationReview.changed ? '发布范围有变化，请重新核对' : `发布${pageName}前确认`}</h3>
        <p>发布后，本期学生可以阅读正文。勾选的草稿会一并发布，也可从作业或资料目录及已发布页面中的相应引用打开。</p>
        {publicationReview.plan.records.length > 0 && <ul className={styles.publicationItems}>
          {publicationReview.plan.records.map(record => {
            const selected = selectedKeys.has(record.key);
            return <li key={record.key}>
              {record.selectable ? <label><input type="checkbox" checked={selected} disabled={pending} onChange={event => {
                const checked = event.target.checked;
                setPublicationReview(current => current && { ...current, selected: checked
                  ? [...current.selected, record.key] : current.selected.filter(key => key !== record.key) });
              }}/><strong>一并发布《{record.title}》{record.source === 'assignment' && '（作业配套资料）'}</strong></label> : <strong>《{record.title}》{record.source === 'assignment' && '（作业配套资料）'}</strong>}
              <p>{publicationOutcome(record, selected)}</p>
            </li>;
          })}
        </ul>}
        {publicationReview.plan.hasProtectedReferences && <p>受保护的关联沿用现有权限，发布正文不会改变它们的可见范围。</p>}
        <div className={styles.actions}>
          <button type="button" className={styles.quietButton} disabled={pending} onClick={() => { setPublicationReview(null); changePreview(false); }}>返回编辑</button>
          <button type="button" className={styles.saveButton} disabled={pending} onClick={() => save(true, { key: publicationReview.plan.key, selected: publicationReview.selected })}>
            {pending ? '正在发布…' : publicationReview.selected.length ? `发布${pageName}及所选内容` : `确认发布${pageName}`}
          </button>
        </div>
      </section>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {success && <p className={styles.saved} role="status">{success}</p>}
      {discard && <div className={styles.discard} role="alert"><p>放弃尚未保存的页面修改？已保存的记录和草稿会保留。</p><div className={styles.actions}><button type="button" className={styles.quietButton} disabled={pending} onClick={() => { setOpen(false); setDiscard(false); }}>放弃修改</button><button type="button" className={styles.saveButton} disabled={pending} onClick={() => setDiscard(false)}>继续编辑</button></div></div>}
      <div className={styles.canvas} hidden={preview}>
        {document && mode === 'write' && <div className={styles.writingCanvas}>
          <div className={styles.titleField} data-title={pageTitle || '页面标题'}>
            <textarea aria-label="页面标题" className={styles.titleInput} rows={1} value={pageTitle ?? ''} onChange={event => updateTitle(event.target.value.replace(/[\r\n]+/g, ' '))} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) event.preventDefault(); }} maxLength={100} placeholder="页面标题" disabled={pending}/>
          </div>
          <CourseMarkdownEditor document={document} catalog={liveCatalog} onChange={updateDocument} disabled={pending || preview} onManageRecord={canManageRecords ? manageRecord : undefined} onReady={onEditorReady}/>
        </div>}
        {document && mode === 'layout' && <CourseBlockEditor key={session} initialDocument={document} catalog={liveCatalog} onChange={next => updateDocument(retainCourseTitleReference(next, titleBlockId.current))} onReady={onEditorReady} disabled={pending || preview} canManageRecords={canManageRecords} onManageRecord={manageRecord} toolbarHost={toolbarHost}/>}
      </div>
      {studentPreview && <div id="course-student-preview" className={`${styles.canvas} ${styles.preview}`} data-student-preview onClickCapture={event => {
        const link = event.target instanceof Element ? event.target.closest('a') : null;
        if (link) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      }}>
        <p className={styles.previewNote}>{publicationReview ? '按本次勾选范围预览。配套资料的作业内入口随作业和资料各自的发布状态显示。' : '按当前作业和资料的发布状态预览。个人提交、反馈和分组会按学生身份显示。'}</p>
        <p className={styles.previewNote}>链接在新标签页打开，按你当前的教学身份查看原件。</p>
        <CourseDocumentView document={studentPreview.document} catalog={studentPreview.catalog} editing/>
      </div>}
    </div>}
    {recordRequest && <CoursePageRecordDialog key={`${recordRequest.blockId}-${recordRequest.recordId || 'new'}`} request={recordRequest} record={recordSnapshot}
      offeringId={offeringId} materials={liveCatalog.resources.filter(record => record.visibilityStatus === 'PUBLISHED' || (!recordRequest.standalone && record.visibilityStatus === 'DRAFT'))} onSaveMaterial={saveAssignmentMaterial}
      pending={pending} error={recordError} courseStatus={courseStatus} onCancel={() => { if (!pending) { setRecordRequest(null); setRecordError(''); } }} onSave={saveRecord}/>}
  </section>;
}
