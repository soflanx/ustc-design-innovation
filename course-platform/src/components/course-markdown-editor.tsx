'use client';

import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { collectCourseReferences, isSafeCourseUrl, type CourseDocument } from '@/lib/course-document';
import type { CourseDocumentCatalog } from '@/lib/course-document-view';
import { applyMarkdownCommand, applyMarkdownLink, markdownEnter, markdownIndent, type MarkdownCommand, type MarkdownSnapshot } from '@/lib/course-markdown-commands';
import { courseMarkdownReferenceLink, parseCourseMarkdownReference } from '@/lib/course-markdown-references';
import { applyCourseMarkdownSource, courseMarkdownImage, insertCourseMarkdownLine, projectCourseMarkdownSource } from '@/lib/course-markdown-source';
import type { CourseBlockEditorHandle, CourseRecordEditRequest } from './course-block-editor';
import { CourseContentIcon } from './course-content-icon';
import { selectableRecords } from './course-editor-record-options';
import { CourseAssignmentDeadline, CourseRecordLink } from './course-record-view';
import { CourseResourcePreview } from './course-resource-preview';
import styles from './course-markdown-editor.module.css';

type Props = {
  document: CourseDocument;
  catalog: CourseDocumentCatalog;
  onChange: (document: CourseDocument) => void;
  disabled?: boolean;
  onReady?: (handle: CourseBlockEditorHandle | null) => void;
  onManageRecord?: (request: CourseRecordEditRequest) => void;
};

type Snapshot = MarkdownSnapshot & { scrollTop: number };
type Panel = 'references' | 'format' | 'link' | 'image';
type HistoryAction = 'undo' | 'redo';
const referenceKinds = ['assignments', 'pages', 'resources'] as const;
type ReferenceKind = typeof referenceKinds[number];
const recordNames = { pages: '课次', assignments: '作业', resources: '资料' };
const recordIcons = { pages: 'link', assignments: 'assignment', resources: 'resource' } as const;
const panelLabels: Record<Panel, string> = { references: '插入课程引用', format: 'Markdown 格式', link: '插入链接', image: '插入图片' };
const formatOptions: { command: MarkdownCommand; label: string; mark: string }[] = [
  { command: 'strike', label: '删除线', mark: '~~' },
  { command: 'ordered', label: '有序列表', mark: '1.' },
  { command: 'task', label: '任务列表', mark: '☐' },
  { command: 'quote', label: '引用文字', mark: '❯' },
  { command: 'inlineCode', label: '行内代码', mark: '‹›' },
  { command: 'codeBlock', label: '代码块', mark: '{ }' },
  { command: 'table', label: '表格', mark: '▦' },
  { command: 'rule', label: '分割线', mark: '—' },
];
const typingInputs = new Set(['insertText', 'deleteContentBackward', 'deleteContentForward', 'insertCompositionText', 'insertFromComposition']);
const historyLimit = 75;

function fieldSnapshot(field: HTMLTextAreaElement): Snapshot {
  return { source: field.value, start: field.selectionStart, end: field.selectionEnd, scrollTop: field.scrollTop };
}

function restoreField(field: HTMLTextAreaElement, snapshot: Snapshot) {
  field.focus({ preventScroll: true });
  field.setSelectionRange(snapshot.start, snapshot.end);
  field.scrollTop = snapshot.scrollTop;
}

function fitField(field: HTMLTextAreaElement) {
  if (!field.clientWidth) return;
  const scrollTop = field.scrollTop;
  field.style.height = '0px';
  field.style.height = Math.min(field.scrollHeight, Math.max(400, window.innerHeight * .76)) + 'px';
  field.scrollTop = scrollTop;
}

export function CourseMarkdownEditor({ document: doc, catalog, onChange, disabled = false, onReady, onManageRecord }: Props) {
  const [projection] = useState(() => projectCourseMarkdownSource(doc, catalog));
  const [source, setSource] = useState(projection.source);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [position, setPosition] = useState<CSSProperties>();
  const [referenceKind, setReferenceKind] = useState<ReferenceKind>('assignments');
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [caption, setCaption] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const referenceButton = useRef<HTMLButtonElement>(null);
  const formatButton = useRef<HTMLButtonElement>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  const imageButton = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const current = useRef<Snapshot>({ source: projection.source, start: projection.source.length, end: projection.source.length, scrollTop: 0 });
  const beforeInput = useRef<Snapshot | null>(null);
  const composing = useRef<Snapshot | null>(null);
  const leaveField = useRef(false);
  const pendingFocus = useRef<Snapshot | null>(null);
  const insertion = useRef(current.current);
  const newRecord = useRef<{ requestId: string; target: Snapshot } | null>(null);
  const addedRecords = useRef(new Set<string>());
  const history = useRef({ past: [] as Snapshot[], future: [] as Snapshot[] });
  const lastTyping = useRef<{ kind: string; time: number; end: number } | null>(null);
  const panelOpen = panel !== null && !disabled;
  const referenceIds = useMemo(() => {
    const { assignmentIds, pageIds, resourceIds } = collectCourseReferences(doc);
    return { assignments: assignmentIds, pages: pageIds, resources: resourceIds };
  }, [doc]);
  const referencedRecords = referenceKinds.flatMap(kind => {
    const byId = new Map((catalog[kind] ?? []).map(record => [record.id, record]));
    return referenceIds[kind].flatMap(id => {
      const record = byId.get(id);
      return record ? [{ kind, record }] : [];
    });
  });

  function remember(field: HTMLTextAreaElement) {
    if (field.value === current.current.source) current.current = fieldSnapshot(field);
  }

  function show(next: Snapshot, focus: boolean) {
    current.current = next;
    if (focus) pendingFocus.current = next;
    setSource(next.source);
    onChange(applyCourseMarkdownSource(doc, projection, next.source));
  }

  function commit(next: Snapshot, before = current.current, inputKind = '', focus = false) {
    const previous = current.current;
    if (next.source === previous.source) {
      if (focus && input.current && !disabled) restoreField(input.current, next);
      current.current = next;
      setSource(next.source);
      return;
    }
    const now = performance.now();
    const typing = typingInputs.has(inputKind);
    const merge = typing && lastTyping.current?.kind === inputKind && now - lastTyping.current.time < 850 &&
      before.start === before.end && before.end === lastTyping.current.end;
    if (!merge) {
      history.current.past.push({ ...before, source: previous.source });
      if (history.current.past.length > historyLimit) history.current.past.shift();
    }
    history.current.future.length = 0;
    lastTyping.current = typing ? { kind: inputKind, time: now, end: next.end } : null;
    show(next, focus);
  }

  function travel(action: HistoryAction) {
    if (disabled || composing.current) return false;
    const { past, future } = history.current;
    const from = action === 'undo' ? past : future;
    const to = action === 'undo' ? future : past;
    const next = from.pop();
    if (!next) return false;
    if (input.current) remember(input.current);
    to.push(current.current);
    lastTyping.current = null;
    beforeInput.current = null;
    show(next, true);
    return true;
  }

  const travelRef = useRef(travel);
  travelRef.current = travel;
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    function before(event: Event) {
      const edit = event as InputEvent;
      if (edit.isComposing || composing.current) return;
      const action = edit.inputType === 'historyUndo' ? 'undo' : edit.inputType === 'historyRedo' ? 'redo' : null;
      if (action && edit.cancelable) {
        edit.preventDefault();
        travelRef.current(action);
      } else if (!action && field) beforeInput.current = fieldSnapshot(field);
    }
    field.addEventListener('beforeinput', before);
    return () => field.removeEventListener('beforeinput', before);
  }, []);

  useLayoutEffect(() => {
    if (input.current) fitField(input.current);
  }, [source, disabled]);

  useEffect(() => {
    const field = input.current;
    if (!field) return;
    let width = field.clientWidth;
    const resize = () => fitField(field);
    const observer = new ResizeObserver(() => {
      if (width === field.clientWidth) return;
      width = field.clientWidth;
      resize();
    });
    observer.observe(field);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, []);

  useLayoutEffect(() => {
    const field = input.current, next = pendingFocus.current;
    if (!field || !next || disabled) return;
    pendingFocus.current = null;
    restoreField(field, next);
    current.current = next;
  }, [source, disabled]);

  function anchor(kind: Panel) {
    return { references: referenceButton, format: formatButton, link: linkButton, image: imageButton }[kind].current;
  }

  useLayoutEffect(() => {
    if (!panel || !panelOpen) return;
    const trigger = anchor(panel);
    if (!trigger) return;
    function place() {
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(410, window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
      const fitsBelow = below >= 235 || below >= above;
      setPosition({
        width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        maxHeight: Math.max(100, fitsBelow ? below : above),
        ...(fitsBelow ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
      });
    }
    function dismiss(event: Event) {
      if (!(event.target instanceof Node) || trigger?.contains(event.target) || popup.current?.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest('[data-course-resource-preview]')) return;
      setPanel(null);
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [panel, panelOpen]);

  function openPanel(kind: Panel) {
    if (panel === kind) { setPanel(null); return; }
    insertion.current = current.current;
    if (kind === 'references') { setReferenceKind('assignments'); setQuery(''); }
    setUrl(''); setCaption(''); setError(''); setPanel(kind);
  }

  function closePanel() {
    if (panel) anchor(panel)?.focus({ preventScroll: true });
    setPanel(null);
  }

  function insert(line: string, target = current.current) {
    const before = current.current;
    const caret = target.source === before.source ? target.end : before.end;
    commit({ ...insertCourseMarkdownLine(before.source, caret, line), scrollTop: before.scrollTop }, before, '', true);
    setPanel(null);
  }

  function format(command: MarkdownCommand) {
    const before = current.current;
    commit({ ...before, ...applyMarkdownCommand(before, command) }, before, '', true);
    setPanel(null);
  }

  function createRecord(kind: 'assignments' | 'resources') {
    if (!onManageRecord) return;
    const blockId = crypto.randomUUID();
    newRecord.current = { requestId: blockId, target: insertion.current };
    setPanel(null);
    onManageRecord({ blockId, kind });
  }

  useImperativeHandle(onReady, () => ({
    insertRecord(request, recordId, title) {
      if (addedRecords.current.has(request.blockId)) return;
      const saved = newRecord.current;
      const name = title ?? catalog[request.kind].find(record => record.id === recordId)?.title ?? recordNames[request.kind];
      insert(courseMarkdownReferenceLink(request.kind, recordId, name), saved?.requestId === request.blockId ? saved.target : current.current);
      addedRecords.current.add(request.blockId);
      newRecord.current = null;
    },
  }));

  function addImage() {
    const href = url.trim();
    if (!isSafeCourseUrl(href) || href.startsWith('#')) { setError('请输入有效的图片网址或站内路径。'); return; }
    insert(courseMarkdownImage(href, caption), insertion.current);
  }

  function addLink() {
    const href = url.trim();
    if (!isSafeCourseUrl(href)) { setError('请输入有效的网址或站内路径。'); return; }
    const before = current.current;
    const target = insertion.current.source === before.source ? insertion.current : before;
    commit({ ...before, ...applyMarkdownLink(target, href, caption.trim() || undefined) }, target, '', true);
    setPanel(null);
  }

  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const kind = referenceKind;
  const matches = panel === 'references' ? selectableRecords(catalog, kind, { includePageDrafts: true })
    .filter(record => parseCourseMarkdownReference('course:' + kind + '/' + encodeURIComponent(record.id)))
    .filter(record => {
      const text = [recordNames[kind], record.title, record.resourceFormat, record.status].filter(Boolean).join(' ').toLocaleLowerCase();
      return terms.every(term => text.includes(term));
    }) : [];
  const hasLinkSelection = insertion.current.start !== insertion.current.end;

  return <div className={styles.editor} data-markdown-editor>
    <div className={styles.format} role="group" aria-label="正文格式" data-course-editor-toolbar>
      <button ref={referenceButton} type="button" className={styles.insert} disabled={disabled}
        onClick={() => openPanel('references')} aria-expanded={panelOpen && panel === 'references'}>
        <CourseContentIcon name="plus" size={16}/>插入
      </button>
      <button type="button" disabled={disabled} aria-label="添加标题" title="添加标题" onClick={() => format('heading')}><CourseContentIcon name="heading" size={17}/></button>
      <button type="button" disabled={disabled} aria-label="加粗" title="加粗（Cmd/Ctrl+B）" onClick={() => format('bold')}><strong aria-hidden="true">B</strong></button>
      <button type="button" disabled={disabled} aria-label="斜体" title="斜体（Cmd/Ctrl+I）" onClick={() => format('italic')}><em aria-hidden="true">I</em></button>
      <button type="button" disabled={disabled} aria-label="无序列表" title="无序列表" onClick={() => format('bullet')}><CourseContentIcon name="list" size={17}/></button>
      <button ref={formatButton} type="button" disabled={disabled} title="更多 Markdown 格式" aria-label="更多格式" aria-expanded={panelOpen && panel === 'format'} onClick={() => openPanel('format')}>
        <CourseContentIcon name="more" size={17}/>
      </button>
      <button ref={linkButton} type="button" disabled={disabled} title="插入链接（Cmd/Ctrl+K）" aria-label="插入链接" aria-expanded={panelOpen && panel === 'link'} onClick={() => openPanel('link')}><CourseContentIcon name="link" size={17}/></button>
      <button ref={imageButton} type="button" disabled={disabled} title="插入图片" aria-label="插入图片" aria-expanded={panelOpen && panel === 'image'} onClick={() => openPanel('image')}><CourseContentIcon name="image" size={17}/></button>
      <div className={styles.history}>
        <button type="button" disabled={disabled || !history.current.past.length} aria-label="撤销" title="撤销" onClick={() => travel('undo')}><CourseContentIcon name="undo" size={17}/></button>
        <button type="button" disabled={disabled || !history.current.future.length} aria-label="重做" title="重做" onClick={() => travel('redo')}><CourseContentIcon name="undo" size={17} className={styles.redo}/></button>
      </div>
    </div>
    {referencedRecords.length > 0 && <section className={styles.references} aria-label="正文中的引用">
      <p>正文中的引用</p>
      <ul>{referencedRecords.map(({ kind: recordKind, record }) => <li key={recordKind + ':' + record.id}>
        <span className={styles.referenceFact}>{recordNames[recordKind]}</span>
        <CourseRecordLink record={record} kind={recordKind} editing className={styles.referenceTitle}/>
        {recordKind === 'assignments' && <span className={styles.referenceFact}><CourseAssignmentDeadline record={record}/></span>}
        {recordKind === 'resources' && record.resourceFormat && <span className={styles.referenceFact}>{record.resourceFormat}</span>}
        {record.visibilityStatus === 'DRAFT' ? <span className={styles.referenceFact}>草稿</span> : recordKind !== 'assignments' && record.status && record.status !== '已发布' &&
          <span className={styles.referenceFact}>{record.status}</span>}
        {recordKind === 'resources' && <CourseResourcePreview href={record.href} title={record.title}/>}
      </li>)}</ul>
    </section>}
    <textarea ref={input} data-writing-area="body" className={styles.field} aria-label="Markdown 正文"
      aria-keyshortcuts="Control+B Meta+B Control+I Meta+I Control+K Meta+K"
      rows={13} placeholder="写下本次教学安排。空一行分段。" disabled={disabled} value={source}
      onFocus={event => remember(event.currentTarget)} onSelect={event => remember(event.currentTarget)} onBlur={event => { remember(event.currentTarget); lastTyping.current = null; leaveField.current = false; }}
      onCompositionStart={event => { composing.current = fieldSnapshot(event.currentTarget); lastTyping.current = null; }}
      onCompositionEnd={event => {
        const before = composing.current ?? current.current;
        composing.current = null; beforeInput.current = null;
        commit(fieldSnapshot(event.currentTarget), before, 'insertCompositionText');
      }}
      onChange={event => {
        const field = event.currentTarget;
        const edit = event.nativeEvent as InputEvent;
        const next = fieldSnapshot(field);
        if (edit.isComposing || composing.current) { setSource(next.source); return; }
        const action = edit.inputType === 'historyUndo' ? 'undo' : edit.inputType === 'historyRedo' ? 'redo' : null;
        if (action) {
          if (!travel(action)) field.value = current.current.source;
          return;
        }
        const before = beforeInput.current ?? current.current;
        beforeInput.current = null;
        commit(next, before, edit.inputType === 'insertFromComposition' ? 'insertCompositionText' : edit.inputType);
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current || event.altKey) return;
        const key = event.key.toLowerCase();
        if (key === 'escape' && !event.metaKey && !event.ctrlKey) { leaveField.current = true; return; }
        const shouldLeave = key === 'tab' && leaveField.current;
        if (key !== 'shift') leaveField.current = false;
        if (shouldLeave) return;
        if (!event.metaKey && !event.ctrlKey) {
          if (key !== 'tab' && (key !== 'enter' || event.shiftKey)) return;
          const before = fieldSnapshot(event.currentTarget);
          const next = key === 'enter' ? markdownEnter(before) : markdownIndent(before, event.shiftKey);
          if (!next || next.source === before.source) return;
          event.preventDefault();
          commit({ ...before, ...next }, before, '', true);
          return;
        }
        if (key === 'z' || key === 'y') {
          event.preventDefault();
          travel(key === 'y' || event.shiftKey ? 'redo' : 'undo');
          return;
        }
        if (!event.shiftKey && key === 'k') {
          event.preventDefault();
          remember(event.currentTarget);
          openPanel('link');
          return;
        }
        const command = event.shiftKey
          ? ({ KeyX: 'strike', Digit7: 'ordered', Digit8: 'bullet', Digit9: 'task' } as const)[event.code as 'KeyX' | 'Digit7' | 'Digit8' | 'Digit9']
          : key === 'b' ? 'bold' : key === 'i' ? 'italic' : undefined;
        if (command) {
          event.preventDefault();
          remember(event.currentTarget);
          format(command);
        }
      }}/>
    {projection.retained.size > 0 && <p className={styles.help}>保留标记代表旧内容块，可连同前后空行移动。需要修改原布局时，可使用「调整布局」。</p>}
    {panelOpen && createPortal(<div ref={popup} className={styles.popup} style={position} role="group"
      aria-label={panelLabels[panel]} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePanel(); }
        if ((panel === 'image' || panel === 'link') && event.key === 'Enter' && event.target instanceof HTMLInputElement && url.trim()) {
          event.preventDefault();
          if (panel === 'image') addImage();
          else addLink();
        }
      }}>
      {panel === 'references' ? <>
        <div className={styles.kinds} role="group" aria-label="引用类型">{referenceKinds.map(item => <button type="button" key={item}
          aria-pressed={referenceKind === item} onClick={() => { setReferenceKind(item); setQuery(''); }}>{recordNames[item]}</button>)}</div>
        <label className={styles.search}>
          <CourseContentIcon name="search" size={17}/>
          <input type="search" autoFocus aria-label={'搜索' + recordNames[kind]} placeholder={'搜索' + recordNames[kind]}
            value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
              if (event.key === 'Enter' && matches.length === 1 && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                const record = matches[0];
                insert(courseMarkdownReferenceLink(kind, record.id, record.title), insertion.current);
              }
            }}/>
        </label>
        {matches.length ? <ul className={styles.results}>{matches.map(record => <li key={record.id}>
          <button type="button" onClick={() => insert(courseMarkdownReferenceLink(kind, record.id, record.title), insertion.current)}>
            <CourseContentIcon name={recordIcons[kind]} size={17}/>
            <span><strong>{record.title}</strong><small className={styles.resultFacts}>
              {kind === 'assignments' && <CourseAssignmentDeadline record={record}/>}
              {record.resourceFormat && <span>{record.resourceFormat}</span>}
              {record.visibilityStatus === 'DRAFT' ? <span>草稿，学生不可见</span> : kind !== 'assignments' && record.status && record.status !== '已发布' && <span>{record.status}</span>}
            </small></span>
          </button>
          {kind === 'assignments' && <CourseRecordLink record={record} kind="assignments" editing className={styles.original}>打开原作业</CourseRecordLink>}
          {kind === 'resources' && <CourseResourcePreview href={record.href} title={record.title} className={styles.original}/>}
        </li>)}</ul> : <p className={styles.help}>{query.trim() ? '没有匹配的' + recordNames[kind] + '。' : '暂无可引用的' + recordNames[kind] + '。'}</p>}
        <div className={styles.actions}>
          {onManageRecord && (kind === 'assignments' || kind === 'resources') && <button type="button" onClick={() => createRecord(kind)}>新建{recordNames[kind]}</button>}
          <button type="button" onClick={closePanel}>取消</button>
        </div>
      </> : panel === 'format' ? <div className={styles.formatOptions}>
        {formatOptions.map(({ command, label, mark }, index) => <button type="button" key={command} autoFocus={index === 0} onClick={() => format(command)}>
          <span aria-hidden="true">{mark}</span>{label}
        </button>)}
        <p className={styles.help}>列表中按 Enter 续行，用 Tab 或 Shift+Tab 调整缩进。按 Esc 后再按 Tab 可离开正文。</p>
      </div> : <div className={styles.linkForm}>
        <label>{panel === 'image' ? '图片网址' : '链接地址'}<input autoFocus value={url} placeholder="https://…" onChange={event => { setUrl(event.target.value); setError(''); }}/></label>
        {(panel === 'image' || !hasLinkSelection) && <label>{panel === 'image' ? '图片说明（选填）' : '显示文字（选填）'}
          <input value={caption} maxLength={500} onChange={event => setCaption(event.target.value)}/>
        </label>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.actions}>
          <button type="button" onClick={closePanel}>取消</button>
          <button type="button" onClick={panel === 'image' ? addImage : addLink} disabled={!url.trim()}>{panelLabels[panel]}</button>
        </div>
      </div>}
    </div>, window.document.body)}
  </div>;
}
