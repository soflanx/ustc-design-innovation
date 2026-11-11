'use client';

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BlockNoteSchema, createHeadingBlockSpec, defaultBlockSpecs, defaultProps, filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from '@blocknote/core';
import type { BlockNoteEditor, PartialBlock } from '@blocknote/core';
import { SideMenuExtension, SuggestionMenu } from '@blocknote/core/extensions';
import { zh } from '@blocknote/core/locales';
import { createReactBlockSpec, DragHandleMenu, SideMenu, SideMenuController, SuggestionMenuController, useBlockNoteEditor, useComponentsContext, useCreateBlockNote, useExtension, useExtensionState, usePortalElement } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/mantine/style.css';
import type { CourseDocument, CourseBlock, CourseInline } from '@/lib/course-document';
import { markdownLayoutBlocks } from '@/lib/course-document-layout';
import { documentRecordIds, type CourseDocumentCatalog } from '@/lib/course-document-view';
import { CourseContentIcon, type CourseIconName } from './course-content-icon';
import { selectableRecords } from './course-editor-record-options';
import { CourseRecordView } from './course-record-view';
import { CourseInteractionContext, CourseRangeTools, useCourseEditorInteractions } from './course-editor-interactions';
import styles from './course-block-editor.module.css';

type RichEditor = BlockNoteEditor<any, any, any>;
type RecordKind = keyof CourseDocumentCatalog;
type RecordConversion = { blockId: string; kind: RecordKind; insertVia?: 'slash' | 'toolbar' };
export type CourseRecordEditRequest = { blockId: string; kind: 'assignments' | 'resources'; recordId?: string; afterBlockId?: string };
export type CourseBlockEditorHandle = { insertRecord: (request: CourseRecordEditRequest, recordId: string, title?: string) => void };
const CatalogContext = createContext<{
  catalog: CourseDocumentCatalog; disabled: boolean; pickerRequest: string | null; consumePickerRequest: () => void;
  keyboardMenuRequest: string | null; consumeMenuRequest: () => void;
  requestRecordConversion: (request: RecordConversion) => void;
  openInsertMenu: (blockId: string, rect: DOMRect) => void;
  canManageRecords: boolean; onManageRecord?: (request: CourseRecordEditRequest) => void;
}>({ catalog: { assignments: [], resources: [], groups: [] }, disabled: false, pickerRequest: null, consumePickerRequest: () => {}, keyboardMenuRequest: null, consumeMenuRequest: () => {}, requestRecordConversion: () => {}, openInsertMenu: () => {}, canManageRecords: false });
const kindNames = { assignments: '作业', resources: '资料', groups: '小组', pages: '课程子页' };
const kindIcons = { assignments: 'assignment', resources: 'resource', groups: 'group', pages: 'link' } as const;
const supportedColors = new Set(['default', 'gray', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']);

/** Rich HTML pastes may carry arbitrary CSS colors; our document uses a fixed palette. */
function normalizePastedColors(blocks: CourseBlock[]): CourseBlock[] {
  function normalize(styles: Record<string, string | number | boolean>) {
    for (const key of ['textColor', 'backgroundColor']) {
      if (key in styles && !supportedColors.has(String(styles[key]))) styles[key] = 'default';
    }
  }
  function inline(content: CourseInline[]) {
    for (const item of content) {
      if (item.type === 'link') inline(item.content);
      else normalize(item.styles);
    }
  }
  for (const block of blocks) {
    normalize(block.props);
    if (block.content) inline(block.content);
    if (block.children) normalizePastedColors(block.children);
  }
  return blocks;
}

function useBlockMenu(disabled: boolean, width = 340, anchorRect?: DOMRect) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!open || disabled) return;
    const update = () => {
      const rect = anchorRect ?? triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const panelWidth = Math.min(width, viewportWidth - 24);
      const below = viewportHeight - rect.bottom;
      const above = rect.top;
      const upwards = below < 240 && above > below;
      setPosition({ position: 'fixed', left: Math.max(12, Math.min(rect.right - panelWidth, viewportWidth - panelWidth - 12)), width: panelWidth,
        ...(upwards ? { bottom: Math.max(12, window.innerHeight - rect.top + 6) } : { top: Math.max(12, rect.bottom + 6) }),
        maxHeight: Math.max(120, Math.min(480, (upwards ? above : below) - 18)), visibility: 'visible' });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    const frame = requestAnimationFrame(() => (panelRef.current?.querySelector<HTMLElement>('[data-autofocus]') || panelRef.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)'))?.focus());
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); window.visualViewport?.removeEventListener('resize', update); };
  }, [open, disabled, width, anchorRect]);
  useEffect(() => {
    if (disabled) { setOpen(false); return; }
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus();
    };
    const focusOutside = (event: FocusEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    document.addEventListener('focusin', focusOutside, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); document.removeEventListener('focusin', focusOutside, true); };
  }, [open, disabled]);
  return { open, setOpen, triggerRef, panelRef, position, close: () => { setOpen(false); triggerRef.current?.focus(); } };
}

function BlockMenu({ menu, label, children }: { menu: ReturnType<typeof useBlockMenu>; label: string; children: ReactNode }) {
  if (!menu.open) return null;
  return createPortal(<div ref={menu.panelRef} className={styles.popover} style={menu.position} role="dialog" aria-label={label} onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <div className={styles.popoverHeader}><span>{label}</span><button type="button" aria-label={`关闭${label}`} className={styles.iconButton} onClick={menu.close}><CourseContentIcon name="close" size={16}/></button></div>{children}
  </div>, document.body);
}

const callout = createReactBlockSpec({
  type: 'callout', propSchema: { ...defaultProps, tone: { default: 'info', values: ['info', 'warning', 'success'] } }, content: 'inline',
}, {
  render: function CalloutBlock({ block, editor, contentRef }) {
    const { disabled } = useContext(CatalogContext);
    const menu = useBlockMenu(disabled, 200);
    const tones = [{ value: 'info', icon: 'info', label: '提示' }, { value: 'warning', icon: 'warning', label: '注意' }, { value: 'success', icon: 'goal', label: '目标' }] as const;
    return <aside className={styles.callout} data-tone={block.props.tone}>
      <button type="button" ref={menu.triggerRef} contentEditable={false} disabled={disabled} className={styles.calloutIcon} aria-label="设置提示框类型" aria-haspopup="dialog" aria-expanded={menu.open} onClick={() => menu.setOpen(value => !value)}><CourseContentIcon name={tones.find(tone => tone.value === block.props.tone)?.icon || 'info'} size={21}/></button>
      <div className={styles.inlineContent} ref={contentRef}/>
      <BlockMenu menu={menu} label="提示框类型"><div className={styles.menuItems}>{tones.map(tone => <button key={tone.value} type="button" disabled={disabled} aria-pressed={tone.value === block.props.tone} onClick={() => { editor.updateBlock(block, { props: { tone: tone.value } }); menu.close(); }}><CourseContentIcon name={tone.icon} size={17}/>{tone.label}</button>)}</div></BlockMenu>
    </aside>;
  },
});

const toggle = createReactBlockSpec({
  type: 'toggle', propSchema: { ...defaultProps, title: { default: '展开详细说明' } }, content: 'inline',
}, {
  render: function ToggleBlock({ block, editor, contentRef }) {
    const { disabled } = useContext(CatalogContext);
    const [expanded, setExpanded] = useState(!(block.content.length || block.children.length));
    return <div className={styles.toggle} data-toggle-collapsed={!expanded}>
      <div contentEditable={false} className={styles.toggleTitle}>
        <button type="button" className={styles.toggleButton} disabled={disabled} aria-label={expanded ? '收起折叠说明' : '展开折叠说明'} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><CourseContentIcon name={expanded ? 'chevronDown' : 'toggle'} size={15}/></button>
        <input disabled={disabled} aria-label="折叠标题" value={block.props.title} maxLength={200} placeholder="折叠标题" onChange={event => editor.updateBlock(block, { props: { title: event.target.value } })} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); setExpanded(true); editor.setTextCursorPosition(block, 'end'); editor.focus(); } }}/>
      </div>
      <div className={styles.toggleContent} hidden={!expanded}><div className={styles.inlineContent} ref={contentRef}/></div>
    </div>;
  },
});

function focusAfterRecord(editor: RichEditor, blockId: string) {
  const next = editor.getNextBlock(blockId);
  const paragraph = next?.type === 'paragraph' && Array.isArray(next.content) && !next.content.length && !next.children.length
    ? next : editor.insertBlocks([{ type: 'paragraph' }], blockId, 'after')[0];
  editor.setTextCursorPosition(paragraph, 'start');
  editor.focus();
}

/** Shared picker for insertion, changing a reference, and converting a text block. */
function RecordPicker({ kind, catalog, disabled, selectedId, onChoose }: {
  kind: RecordKind; catalog: CourseDocumentCatalog; disabled: boolean; selectedId?: string; onChoose: (recordId: string) => void;
}) {
  const { canManageRecords } = useContext(CatalogContext);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const results = selectableRecords(catalog, kind).filter(item => `${item.title} ${item.subtitle || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useEffect(() => {
    const search = searchRef.current;
    // A modal focuses the field after showModal(). In a popover the picker owns that focus.
    if (search && !search.closest('dialog')) search.focus({ preventScroll: true });
  }, []);
  return <>
    <div className={styles.searchField}><CourseContentIcon name="search" size={16}/><input ref={searchRef} data-autofocus type="search" value={query} placeholder={`搜索${kindNames[kind]}`} aria-label={`搜索可关联${kindNames[kind]}`} disabled={disabled} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); resultsRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
      if (event.key === 'Enter' && results.length) { event.preventDefault(); onChoose(results[0].id); }
    }}/></div>
    <div ref={resultsRef} className={styles.recordResults} role="group" aria-label={`可关联的${kindNames[kind]}`} onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const buttons = [...(resultsRef.current?.querySelectorAll<HTMLButtonElement>('button') || [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      if (event.key === 'ArrowUp' && index === 0) searchRef.current?.focus();
      else buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    }}>{results.map(item => <button type="button" key={item.id} disabled={disabled} aria-pressed={item.id === selectedId} onClick={() => onChoose(item.id)}><CourseContentIcon name={kindIcons[kind]} size={17}/><span>{item.title}{item.status && <small>{item.status}</small>}</span>{item.id === selectedId && <CourseContentIcon name="check" size={15}/>}</button>)}{!results.length && <p className={styles.noResults}>{query.trim() ? '没有找到匹配的记录。' : kind === 'pages' ? '暂无可关联的已发布课程子页。' : kind === 'groups' ? '暂无已有小组，请在课程管理中创建。' : canManageRecords ? `暂无已有${kindNames[kind]}，可从“插入 → 新建${kindNames[kind]}”创建。` : `暂无已有${kindNames[kind]}，请联系本期教师创建。`}</p>}</div>
  </>;
}

const courseRecord = createReactBlockSpec({
  type: 'courseRecord', propSchema: { ...defaultProps,
    kind: { default: 'assignments', values: ['assignments', 'resources', 'groups', 'pages'] },
    recordId: { default: '' }, display: { default: 'link', values: ['link', 'card'] },
  }, content: 'none',
}, {
  render: function RecordBlock({ block, editor }) {
    const { catalog, disabled, pickerRequest, consumePickerRequest, canManageRecords, onManageRecord } = useContext(CatalogContext);
    const menu = useBlockMenu(disabled, 360);
    const kind = block.props.kind;
    const record = catalog[kind]?.find(item => item.id === block.props.recordId);
    const canChoose = kind !== 'pages' || catalog.pages?.some(page => page.visibilityStatus === 'PUBLISHED');
    const [choosing, setChoosing] = useState(!record);
    useEffect(() => {
      if (pickerRequest !== block.id || disabled) return;
      setChoosing(true); menu.setOpen(true); consumePickerRequest();
    }, [pickerRequest, block.id, disabled, menu.setOpen, consumePickerRequest]);
    function choose(recordId: string) {
      if (disabled) return;
      const inserting = !block.props.recordId;
      editor.updateBlock(block, { props: { recordId } });
      menu.setOpen(false); setChoosing(false);
      if (inserting) focusAfterRecord(editor, block.id);
      else menu.close();
    }
    function openSettings() {
      setChoosing(!record); menu.setOpen(value => !value);
    }
    const controls = <span className={styles.referenceControls}>
      {record && (kind === 'assignments' || kind === 'resources') && canManageRecords && onManageRecord && <button type="button" className={styles.editRecordButton} disabled={disabled} aria-label={`编辑与发布${kindNames[kind]}：${record.title}`} onClick={() => { menu.setOpen(false); onManageRecord({ blockId: block.id, kind, recordId: record.id }); }}>编辑</button>}
      <button type="button" ref={menu.triggerRef} className={styles.viewSettings} disabled={disabled} aria-label={`设置${kindNames[kind]}引用`} aria-haspopup="dialog" aria-expanded={menu.open} onClick={openSettings}><CourseContentIcon name="more" size={17}/></button>
    </span>;
    return <div className={styles.referenceBlock} contentEditable={false} onKeyDown={event => event.stopPropagation()}>
      {record ? <CourseRecordView record={record} kind={kind} display={block.props.display} editing controls={controls}/> : <button type="button" ref={menu.triggerRef} className={styles.emptyReference} disabled={disabled || !canChoose} aria-haspopup="dialog" aria-expanded={menu.open} onClick={openSettings}><CourseContentIcon name={kindIcons[kind]} size={19}/><span>{kind === 'pages' && block.props.recordId ? '原课程子页暂不可用，引用已保留。' : `选择要关联的${kindNames[kind]}`}</span><CourseContentIcon name="search" size={15}/></button>}
      <BlockMenu menu={menu} label={choosing ? `关联${kindNames[kind]}` : '引用设置'}>
        {choosing ? <>
          {record && <button type="button" className={styles.backButton} onClick={() => setChoosing(false)}>返回引用设置</button>}
          <RecordPicker kind={kind} catalog={catalog} disabled={disabled} selectedId={block.props.recordId} onChoose={choose}/>
        </> : <>
          {record && <div className={`${styles.settingSection} ${styles.referenceTarget}`}>
            <p>当前关联的{kindNames[kind]}</p>
            <strong>{record.title}</strong>
            <a href={record.href} target="_blank" rel="noopener noreferrer">打开原{kindNames[kind]}<CourseContentIcon name="external" size={13}/></a>
          </div>}
          <div className={styles.settingSection}><p>显示为</p><div className={styles.layoutButtons} role="group" aria-label="引用呈现方式"><button type="button" disabled={disabled} aria-pressed={block.props.display === 'link'} onClick={() => editor.updateBlock(block, { props: { display: 'link' } })}><CourseContentIcon name="link" size={16}/>简洁链接</button><button type="button" disabled={disabled} aria-pressed={block.props.display === 'card'} onClick={() => editor.updateBlock(block, { props: { display: 'card' } })}><CourseContentIcon name="grid" size={16}/>卡片</button></div></div>
          {canChoose && <div className={styles.menuItems}><button type="button" disabled={disabled} onClick={() => setChoosing(true)}><CourseContentIcon name="link" size={17}/>更换关联{kindNames[kind]}</button></div>}
        </>}
      </BlockMenu>
    </div>;
  },
});

function splitDataView(editor: RichEditor, block: CourseBlock) {
  const kind = block.props.kind;
  if (kind !== 'assignments' && kind !== 'resources' && kind !== 'groups') return;
  const title = String(block.props.title || '');
  const display = block.props.layout === 'cards' ? 'card' : 'link';
  const appearance = Object.fromEntries(['textColor', 'backgroundColor', 'textAlignment'].filter(key => key in block.props).map(key => [key, block.props[key]]));
  const replacements: PartialBlock<any, any, any>[] = [
    ...(title.trim() ? [{ type: 'heading', props: { ...appearance, level: 2 }, content: title }] : []),
    ...documentRecordIds(block.props.ids).map(recordId => ({ type: 'courseRecord', props: { ...appearance, kind, recordId, display } })),
    ...(block.children || []),
  ];
  editor.replaceBlocks([block.id], replacements);
}

const courseData = createReactBlockSpec({
  type: 'courseData', propSchema: {
    ...defaultProps,
    kind: { default: 'assignments', values: ['assignments', 'resources', 'groups'] },
    ids: { default: '[]' }, layout: { default: 'list', values: ['cards', 'list'] }, title: { default: '' }, grouped: { default: true },
  }, content: 'none',
}, {
  render: function DataBlock({ block, editor }) {
    const { catalog, disabled } = useContext(CatalogContext);
    const menu = useBlockMenu(disabled);
    const kind = block.props.kind;
    const selectedIds = documentRecordIds(block.props.ids);
    const records = catalog[kind];
    const selected = selectedIds.flatMap(id => records.filter(record => record.id === id));
    function selectRecord(id: string, checked: boolean) {
      const next = checked ? [...selectedIds, id] : selectedIds.filter(value => value !== id);
      editor.updateBlock(block, { props: { ids: JSON.stringify([...new Set(next)]) } });
    }
    function moveRecord(id: string, direction: number) {
      const next = [...selectedIds];
      const index = next.indexOf(id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= next.length) return;
      [next[index], next[target]] = [next[target], next[index]];
      editor.updateBlock(block, { props: { ids: JSON.stringify(next) } });
    }
    return <div className={styles.dataBlock} contentEditable={false} onKeyDown={event => event.stopPropagation()}>
      <div className={styles.dataHeading}>
        <CourseContentIcon name="database" className={styles.databaseIcon} size={19}/>
        <input type="text" className={styles.dataTitle} disabled={disabled} aria-label="合集标题" value={block.props.title} maxLength={200} placeholder={kindNames[kind]} onChange={event => editor.updateBlock(block, { props: { title: event.target.value } })}/>
        <span className={styles.recordCount}>{selected.length}</span>
        <button type="button" ref={menu.triggerRef} className={styles.viewSettings} disabled={disabled} aria-label={`设置${kindNames[kind]}合集`} title="设置合集" aria-haspopup="dialog" aria-expanded={menu.open} onClick={() => menu.setOpen(value => !value)}><CourseContentIcon name="more" size={17}/></button>
      </div>
      {selected.length ? <div className={block.props.layout === 'cards' ? styles.databaseCards : styles.databaseRows}>{selected.map(record => <CourseRecordView key={record.id} record={record} kind={kind} display={block.props.layout === 'cards' ? 'card' : 'link'} editing/>)}</div> : <button type="button" className={styles.emptyView} disabled={disabled} onClick={() => menu.setOpen(true)}><CourseContentIcon name="plus" size={16}/>选择要显示的{kindNames[kind]}</button>}
      <BlockMenu menu={menu} label={`设置${kindNames[kind]}合集`}>
        <fieldset className={styles.settingsFields} disabled={disabled}>
          <div className={styles.settingSection}><p>布局</p><div className={styles.layoutButtons} role="group" aria-label="数据视图呈现方式"><button type="button" aria-pressed={block.props.layout === 'cards'} onClick={() => editor.updateBlock(block, { props: { layout: 'cards' } })}><CourseContentIcon name="grid" size={16}/>卡片</button><button type="button" aria-pressed={block.props.layout === 'list'} onClick={() => editor.updateBlock(block, { props: { layout: 'list' } })}><CourseContentIcon name="list" size={16}/>列表</button></div></div>
          <div className={styles.settingSection}><p>显示内容</p>{records.length ? <div className={styles.choices}>{records.map(record => <label key={record.id}><input type="checkbox" checked={selectedIds.includes(record.id)} onChange={event => selectRecord(record.id, event.target.checked)}/><span>{record.title}{record.status && <small>{record.status}</small>}</span></label>)}</div> : <p className={styles.emptyRecords}>本期暂无可选择的{kindNames[kind]}。</p>}</div>
          {selected.length > 0 && <div className={styles.settingSection}><p>显示顺序</p><ol className={styles.recordOrder}>{selected.map((record, index) => <li key={record.id}><span>{record.title}</span><div><button type="button" aria-label={`上移 ${record.title}`} disabled={index === 0} onClick={() => moveRecord(record.id, -1)}><CourseContentIcon name="arrowUp" size={15}/></button><button type="button" aria-label={`下移 ${record.title}`} disabled={index === selected.length - 1} onClick={() => moveRecord(record.id, 1)}><CourseContentIcon name="arrowDown" size={15}/></button><button type="button" aria-label={`移除 ${record.title}`} onClick={() => selectRecord(record.id, false)}><CourseContentIcon name="close" size={15}/></button></div></li>)}</ol></div>}
          <div className={styles.settingSection}><div className={styles.menuItems}><button type="button" disabled={disabled} onClick={() => { menu.setOpen(false); splitDataView(editor, block as CourseBlock); }}><CourseContentIcon name="split" size={17}/>拆成独立内容</button></div></div>
        </fieldset>
      </BlockMenu>
    </div>;
  },
});

const protectedBlock = createReactBlockSpec({ type: 'protected', propSchema: {}, content: 'none' }, {
  render: () => <div className={styles.protected} contentEditable={false}>部分内容受可见权限限制，保存时会保留。</div>,
});

// Layout mode treats continuous Markdown as one movable object. Keep the literal source
// out of BlockNote's inline schema, which can otherwise normalize line breaks and marks.
const markdownRegion = createReactBlockSpec({ type: 'markdown', propSchema: { ...defaultProps, source: { default: '' } }, content: 'none' }, {
  render: function MarkdownLayoutRegion({ block, editor }) {
    const { disabled } = useContext(CatalogContext);
    const [editing, setEditing] = useState(false);
    return <div className={styles.markdownRegion} contentEditable={false}>
      {editing ? <textarea aria-label="编辑这段 Markdown" autoFocus disabled={disabled} rows={Math.min(16, Math.max(3, block.props.source.split('\n').length))} value={block.props.source}
        onKeyDown={event => event.stopPropagation()} onChange={event => editor.updateBlock(block, { props: { source: event.target.value } })}/> : <span>{block.props.source || '正文'}</span>}
      <button type="button" disabled={disabled} onClick={() => setEditing(value => !value)}>{editing ? '收起编辑' : '编辑这段正文'}</button>
    </div>;
  },
});

const schema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    heading: createHeadingBlockSpec({ levels: [1, 2, 3], allowToggleHeadings: false }),
    bulletListItem: defaultBlockSpecs.bulletListItem,
    numberedListItem: defaultBlockSpecs.numberedListItem,
    checkListItem: defaultBlockSpecs.checkListItem,
    quote: defaultBlockSpecs.quote,
    image: defaultBlockSpecs.image,
    markdown: markdownRegion(), callout: callout(), toggle: toggle(), courseRecord: courseRecord(), courseData: courseData(), protected: protectedBlock(),
  },
});

type EditorBlock = PartialBlock<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>;
type InsertOption = { label: string; subtext?: string; type: string; createKind?: 'assignments' | 'resources'; props?: Record<string, string | number | boolean>; content?: CourseInline[]; aliases?: string[]; group: string; icon: CourseIconName };
const createOptions: InsertOption[] = [
  { label: '新建作业', type: 'courseRecord', createKind: 'assignments', group: '新建', icon: 'assignment', aliases: ['create assignment', '布置作业'] },
  { label: '新建资料', type: 'courseRecord', createKind: 'resources', group: '新建', icon: 'resource', aliases: ['create resource', '添加资料'] },
];
const insertOptions: InsertOption[] = [
  { label: '正文', type: 'paragraph', aliases: ['text', 'p'], group: '基础内容', icon: 'text' },
  { label: '一级标题', type: 'heading', props: { level: 1 }, aliases: ['h1', 'heading'], group: '基础内容', icon: 'heading' },
  { label: '二级标题', type: 'heading', props: { level: 2 }, aliases: ['h2'], group: '基础内容', icon: 'heading' },
  { label: '三级标题', type: 'heading', props: { level: 3 }, aliases: ['h3'], group: '基础内容', icon: 'heading' },
  { label: '项目列表', type: 'bulletListItem', aliases: ['list', 'bullet', '无序列表'], group: '基础内容', icon: 'list' },
  { label: '编号列表', type: 'numberedListItem', aliases: ['number', '有序列表'], group: '基础内容', icon: 'numbered' },
  { label: '勾选清单', type: 'checkListItem', aliases: ['todo', 'check'], group: '基础内容', icon: 'check' },
  { label: '引用', type: 'quote', aliases: ['quote'], group: '基础内容', icon: 'quote' },
  { label: '关联已有作业', subtext: '选择一项作业，显示为链接或卡片', type: 'courseRecord', props: { kind: 'assignments', display: 'link' }, aliases: ['assignment', '任务', '关联作业'], group: '已有课程内容', icon: 'assignment' },
  { label: '关联已有资料', subtext: '选择一份资料，显示为链接或卡片', type: 'courseRecord', props: { kind: 'resources', display: 'link' }, aliases: ['resource', '材料', '关联资料'], group: '已有课程内容', icon: 'resource' },
  { label: '关联已有小组', subtext: '选择一个小组，显示为链接或卡片', type: 'courseRecord', props: { kind: 'groups', display: 'link' }, aliases: ['group', 'project', '项目', '关联小组'], group: '已有课程内容', icon: 'group' },
  { label: '关联课程子页', subtext: '选择本期已发布的子页', type: 'courseRecord', props: { kind: 'pages', display: 'link' }, aliases: ['page', '课次'], group: '已有课程内容', icon: 'link' },
  { label: '提示框', type: 'callout', aliases: ['callout', 'tip'], group: '图文内容', icon: 'info' },
  { label: '折叠说明', type: 'toggle', aliases: ['toggle'], group: '图文内容', icon: 'toggle' },
  { label: '图片（粘贴网址）', type: 'image', aliases: ['image', 'photo', '图片链接'], group: '图文内容', icon: 'image' },
  { label: '作业合集', subtext: '选择多项作业，一起展示并调整顺序', type: 'courseData', props: { kind: 'assignments', title: '作业', grouped: true }, aliases: ['assignment database', '作业数据库视图'], group: '多项内容一起展示', icon: 'database' },
  { label: '资料合集', subtext: '选择多份资料，一起展示并调整顺序', type: 'courseData', props: { kind: 'resources', title: '资料', grouped: true }, aliases: ['resource database', '资料数据库视图'], group: '多项内容一起展示', icon: 'database' },
  { label: '小组合集', subtext: '选择多个小组，一起展示并调整顺序', type: 'courseData', props: { kind: 'groups', title: '小组与项目', grouped: true }, aliases: ['group database', '小组数据库视图'], group: '多项内容一起展示', icon: 'database' },
];

function containsProtected(block: { type: string; children?: { type: string; children?: unknown[] }[] }): boolean {
  return block.type === 'protected' || !!block.children?.some(child => containsProtected(child as CourseBlock));
}
function duplicateBlock(block: CourseBlock): CourseBlock {
  return { ...JSON.parse(JSON.stringify(block)), id: crypto.randomUUID(), children: block.children?.map(duplicateBlock) || [] };
}

// Inline-to-inline conversions preserve their content in place. Record conversion
// waits for a choice and preserves any existing rich text in a preceding paragraph.
const textBlockTypes = new Set(['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'quote']);
const conversionOptions = insertOptions.filter(option => textBlockTypes.has(option.type));
const recordKinds: RecordKind[] = ['assignments', 'resources', 'groups', 'pages'];

function insertAtAnchor(editor: RichEditor, anchorId: string, nextBlock: EditorBlock) {
  const anchor = editor.getBlock(anchorId);
  if (!anchor) return;
  const empty = anchor.type === 'paragraph' && Array.isArray(anchor.content) && !anchor.content.length && !anchor.children.length;
  return empty ? editor.updateBlock(anchor, nextBlock) : editor.insertBlocks([nextBlock], anchor, 'after')[0];
}

function RecordConversionDialog({ request, editor, catalog, disabled, onCancel, onConverted }: {
  request: RecordConversion; editor: RichEditor; catalog: CourseDocumentCatalog; disabled: boolean;
  onCancel: () => void; onConverted: (kind: RecordKind) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const source = editor.getBlock(request.blockId) as CourseBlock | undefined;
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog?.isConnected) return;
    // Background tabs can suspend animation frames. Open the mounted dialog in this commit.
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLInputElement>('input[type="search"]')?.focus({ preventScroll: true });
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  function cancel() {
    dialogRef.current?.close();
    onCancel();
  }
  function choose(recordId: string) {
    if (disabled || !selectableRecords(catalog, request.kind).some(record => record.id === recordId)) return;
    const block = editor.getBlock(request.blockId) as CourseBlock | undefined;
    if (!block) { cancel(); return; }
    if (request.insertVia) {
      const reference = { type: 'courseRecord', props: { kind: request.kind, recordId, display: 'link' } } as EditorBlock;
      dialogRef.current?.close();
      if (request.insertVia === 'slash') editor.setTextCursorPosition(block.id, 'end');
      const inserted = request.insertVia === 'slash' ? insertOrUpdateBlockForSlashMenu(editor, reference) : insertAtAnchor(editor, block.id, reference);
      onConverted(request.kind);
      if (inserted) focusAfterRecord(editor, inserted.id);
      return;
    }
    if (!textBlockTypes.has(block.type)) { cancel(); return; }
    const appearance = Object.fromEntries(['textColor', 'backgroundColor', 'textAlignment'].filter(key => key in block.props).map(key => [key, block.props[key]]));
    const replacements: PartialBlock<any, any, any>[] = [
      ...(block.content?.length ? [{ type: 'paragraph', props: appearance, content: block.content, children: [] }] : []),
      { id: block.id, type: 'courseRecord', props: { ...appearance, kind: request.kind, recordId, display: 'link' }, children: block.children ?? [] },
    ];
    // One document transaction keeps the whole conversion together for Undo.
    dialogRef.current?.close();
    editor.replaceBlocks([block.id], replacements);
    onConverted(request.kind);
    // Focus the converted reference without adding an unrelated empty paragraph.
    queueMicrotask(() => editor.domElement?.querySelector<HTMLAnchorElement>(`[data-node-type="blockContainer"][data-id="${CSS.escape(block.id)}"] [data-course-reference] a`)?.focus({ preventScroll: true }));
  }
  return createPortal(<dialog ref={dialogRef} className={`${styles.popover} ${styles.conversionDialog}`} aria-label={`关联到${kindNames[request.kind]}`} onCancel={event => { event.preventDefault(); cancel(); }} onKeyDown={event => event.stopPropagation()} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) cancel();
  }}>
    <div className={styles.popoverHeader}><span>关联到{kindNames[request.kind]}</span><button type="button" className={styles.iconButton} aria-label="取消关联转换" onClick={cancel}><CourseContentIcon name="close" size={16}/></button></div>
    {!request.insertVia && !!source?.content?.length && <p className={styles.referenceHelp}>原文字保留在上方，子内容也会保留。</p>}
    <RecordPicker kind={request.kind} catalog={catalog} disabled={disabled} onChoose={choose}/>
  </dialog>, document.body);
}

function CourseBlockTypeMenu({ block, disabled }: { block: CourseBlock; disabled: boolean }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as RichEditor;
  const portalElement = usePortalElement();
  const { catalog, requestRecordConversion } = useContext(CatalogContext);
  if (!textBlockTypes.has(block.type)) return null;
  const Menu = Components.Generic.Menu;
  function convert(option: InsertOption) {
    const appearance = Object.fromEntries(['textColor', 'backgroundColor', 'textAlignment'].filter(key => key in block.props).map(key => [key, block.props[key]]));
    editor.updateBlock(block.id, {
      type: option.type,
      props: { ...appearance, ...option.props, ...(option.type === 'checkListItem' ? { checked: block.type === 'checkListItem' && block.props.checked === true } : {}) },
      content: block.content,
      children: block.children,
    });
    editor.setTextCursorPosition(block.id, 'end');
    editor.focus();
  }
  return <Menu.Root sub position="right-start" portalElement={portalElement}>
    <Menu.Trigger sub><Menu.Item className="bn-menu-item" subTrigger disabled={disabled} icon={<CourseContentIcon name="text" size={16}/>}>转换为</Menu.Item></Menu.Trigger>
    <Menu.Dropdown sub className="bn-menu-dropdown">{conversionOptions.map(option => <Menu.Item key={option.label} className="bn-menu-item" disabled={disabled} checked={block.type === option.type && (option.type !== 'heading' || block.props.level === option.props?.level)} icon={<CourseContentIcon name={option.icon} size={16}/>} onClick={() => convert(option)}>{option.label}</Menu.Item>)}
      <Menu.Divider/>
      {recordKinds.filter(kind => kind !== 'pages' || catalog.pages?.some(page => page.visibilityStatus === 'PUBLISHED')).map(kind => <Menu.Item key={kind} className="bn-menu-item" disabled={disabled} icon={<CourseContentIcon name={kindIcons[kind]} size={16}/>} onClick={() => requestRecordConversion({ blockId: block.id, kind })}>关联到{kindNames[kind]}</Menu.Item>)}
    </Menu.Dropdown>
  </Menu.Root>;
}

function CourseDragHandleMenu() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as RichEditor;
  const { disabled } = useContext(CatalogContext);
  const interactions = useContext(CourseInteractionContext);
  const block = useExtensionState(SideMenuExtension, { editor, selector: state => state?.block });
  if (!block) return null;
  const frozen = disabled || block.type === 'protected';
  const protectedContent = containsProtected(block);
  const Item = Components.Generic.Menu.Item;
  function insertText(placement: 'before' | 'after') {
    const added = editor.insertBlocks([{ type: 'paragraph' }], block!, placement)[0];
    editor.setTextCursorPosition(added, 'start'); editor.focus();
  }
  return <DragHandleMenu>
    <CourseBlockTypeMenu block={block as CourseBlock} disabled={disabled}/>
    <Item className="bn-menu-item" icon={<CourseContentIcon name="grip" size={16}/>} disabled={disabled} onClick={() => interactions?.beginRange(block.id)}>选择多块</Item>
    <Item className="bn-menu-item" icon={<CourseContentIcon name="copy" size={16}/>} disabled={disabled || protectedContent} onClick={() => editor.insertBlocks([duplicateBlock(block as CourseBlock)], block, 'after')}>{protectedContent ? '创建副本（含受限内容）' : '创建副本'}</Item>
    <Item className="bn-menu-item" icon={<CourseContentIcon name="arrowUp" size={16}/>} disabled={disabled || !editor.getPrevBlock(block)} onClick={() => editor.moveBlocksUp(block)}>上移</Item>
    <Item className="bn-menu-item" icon={<CourseContentIcon name="arrowDown" size={16}/>} disabled={disabled || !editor.getNextBlock(block)} onClick={() => editor.moveBlocksDown(block)}>下移</Item>
    <Components.Generic.Menu.Divider/>
    <Item className="bn-menu-item" icon={<CourseContentIcon name="insertAbove" size={16}/>} disabled={disabled} onClick={() => insertText('before')}>在上方插入正文</Item>
    <Item className="bn-menu-item" icon={<CourseContentIcon name="insertBelow" size={16}/>} disabled={disabled} onClick={() => insertText('after')}>在下方插入正文</Item>
    {block.type === 'courseData' && <Item className="bn-menu-item" icon={<CourseContentIcon name="split" size={16}/>} disabled={disabled} onClick={() => splitDataView(editor, block as CourseBlock)}>拆成独立内容</Item>}
    <Components.Generic.Menu.Divider/>
    <Item className="bn-menu-item" icon={<CourseContentIcon name="trash" size={16}/>} disabled={frozen} onClick={() => editor.removeBlocks([block])}>{block.type === 'courseRecord' ? <span className={styles.menuLabel}>移出当前安排<small>保留原记录</small></span> : '删除'}</Item>
  </DragHandleMenu>;
}

function CourseDragHandle() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as RichEditor;
  const portalElement = usePortalElement();
  const sideMenu = useExtension(SideMenuExtension);
  const block = useExtensionState(SideMenuExtension, { selector: state => state?.block });
  const pressedBlockId = useRef<string | null>(null);
  const interactions = useContext(CourseInteractionContext);
  if (!block) return null;
  return <Components.Generic.Menu.Root position="bottom-start" portalElement={portalElement} onOpenChange={open => open ? sideMenu.freezeMenu() : sideMenu.unfreezeMenu()}>
    <Components.Generic.Menu.Trigger>
      <button type="button" className={`${styles.blockTool} ${styles.dragHandle}`} draggable aria-label="内容块操作：点击打开菜单，拖动调整顺序" title="拖动调整顺序 · 点击打开菜单" onPointerDown={event => {
        if (event.button === 0) { pressedBlockId.current = block.id; interactions?.rememberSelection(); }
      }} onPointerUp={() => { pressedBlockId.current = null; }} onPointerCancel={() => { pressedBlockId.current = null; }} onDragStart={event => {
        // Keep the block pressed even if a fast pointer movement updates hover
        // before the browser emits dragstart.
        const target = editor.getBlock(pressedBlockId.current || block.id);
        if (!target) { event.preventDefault(); return; }
        if (interactions) interactions.startDrag(event, target.id);
        else sideMenu.blockDragStart(event, target);
      }} onDragEnd={() => { pressedBlockId.current = null; if (interactions) interactions.endDrag(); else sideMenu.blockDragEnd(); }}><CourseContentIcon name="grip" size={18}/></button>
    </Components.Generic.Menu.Trigger>
    <CourseDragHandleMenu/>
  </Components.Generic.Menu.Root>;
}

function CourseSideMenu() {
  const root = useRef<HTMLDivElement>(null);
  const editor = useBlockNoteEditor() as RichEditor;
  const sideMenu = useExtension(SideMenuExtension);
  const block = useExtensionState(SideMenuExtension, { selector: state => state?.block });
  const { keyboardMenuRequest, consumeMenuRequest, openInsertMenu } = useContext(CatalogContext);
  useEffect(() => {
    if (!block || keyboardMenuRequest !== block.id) return;
    const handle = root.current?.querySelector<HTMLButtonElement>('button[draggable="true"]');
    if (handle) { handle.focus(); handle.click(); consumeMenuRequest(); }
  }, [keyboardMenuRequest, block, consumeMenuRequest]);
  // Menu open/close owns the freeze state. Cleaning up this transient hover
  // component would also hide it during React Strict Mode's effect replay.
  function addBlock(trigger: HTMLButtonElement) {
    if (!block) return;
    // Capture the insertion point without writing a placeholder paragraph.
    const rect = trigger.getBoundingClientRect();
    sideMenu.unfreezeMenu();
    openInsertMenu(block.id, rect);
  }
  return <div ref={root} className={styles.sideTools}><SideMenu>
    <button type="button" className={styles.blockTool} aria-label="添加内容块" title="添加内容块" onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      // Run before the handle menu's outside-click dismissal removes this
      // button, and keep focus on the editor rather than the transient tool.
      event.preventDefault();
      addBlock(event.currentTarget);
    }} onClick={event => { if (event.detail === 0) addBlock(event.currentTarget); }}><CourseContentIcon name="plus" size={18}/></button>
    <CourseDragHandle/>
  </SideMenu></div>;
}

/** Align controls with the rendered first line, including heading margins and custom titles. */
function firstLineCenter(element: HTMLElement): number {
  const content = element.matches('.bn-block-content') ? element : element.querySelector<HTMLElement>('.bn-block-content') || element;
  const type = content.dataset.contentType;
  const title = type === 'toggle' ? content.querySelector<HTMLElement>('input[aria-label="折叠标题"]')
    : type === 'courseData' ? content.querySelector<HTMLElement>('input[aria-label="合集标题"]')
    : type === 'courseRecord' ? content.querySelector<HTMLElement>('[data-course-reference] a, button') : null;
  const line = title || content.querySelector<HTMLElement>('.bn-inline-content') || content;
  if (line instanceof HTMLInputElement) {
    const rect = line.getBoundingClientRect();
    return rect.top + rect.height / 2;
  }
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let text: Node | null;
  while ((text = walker.nextNode())) {
    if (!text.textContent?.length) continue;
    const range = document.createRange();
    range.setStart(text, 0); range.setEnd(text, 1);
    const rect = range.getClientRects()[0];
    if (rect?.height) return rect.top + rect.height / 2;
  }
  const rect = line.getBoundingClientRect();
  const computed = getComputedStyle(line);
  const lineHeight = Number.parseFloat(computed.lineHeight) || Number.parseFloat(computed.fontSize) * 1.5;
  return rect.top + Number.parseFloat(computed.borderTopWidth || '0') + Number.parseFloat(computed.paddingTop || '0') + Math.min(rect.height, lineHeight) / 2;
}

function CourseSideMenuController() {
  const options = useMemo<NonNullable<ComponentProps<typeof SideMenuController>['floatingUIOptions']>>(() => ({
    // Closing popovers contain a static HTML snapshot, not live drag handlers.
    // Remove that snapshot immediately so it cannot look like a usable handle.
    useTransitionStylesProps: { duration: { open: 80, close: 0 } },
    useTransitionStatusProps: { duration: { open: 80, close: 0 } },
    useFloatingOptions: {
      placement: 'left-start',
      middleware: [{ name: 'courseFirstLine', fn: ({ elements, rects, y }) => {
        const reference = elements.reference instanceof HTMLElement ? elements.reference : 'contextElement' in elements.reference ? elements.reference.contextElement : undefined;
        if (!(reference instanceof HTMLElement)) return {};
        return { y: y + firstLineCenter(reference) - reference.getBoundingClientRect().top - rects.floating.height / 2 };
      } }],
    },
  }), []);
  return <SideMenuController sideMenu={CourseSideMenu} floatingUIOptions={options}/>;
}

export default function CourseBlockEditor({ initialDocument, catalog, onChange, disabled, onReady, canManageRecords = false, onManageRecord, toolbarHost }: {
  initialDocument: CourseDocument; catalog: CourseDocumentCatalog; onChange: (document: CourseDocument) => void; disabled: boolean; onReady?: (handle: CourseBlockEditorHandle | null) => void;
  canManageRecords?: boolean; onManageRecord?: (request: CourseRecordEditRequest) => void;
  toolbarHost?: HTMLElement | null;
}) {
  const editor = useCreateBlockNote({
    schema,
    dropCursor: { color: '#4285b4', width: 3 },
    dictionary: { ...zh, placeholders: { ...zh.placeholders, default: '直接写字，或输入 / 添加内容', emptyDocument: '直接写字，或输入 / 添加内容' } },
    initialContent: (initialDocument.blocks.length ? markdownLayoutBlocks(initialDocument.blocks, true) : [{ type: 'paragraph' }]) as EditorBlock[],
  });
  const interactions = useCourseEditorInteractions(editor, disabled);
  const [insertMenuRect, setInsertMenuRect] = useState<DOMRect>();
  const insertAnchor = useRef<string | undefined>(undefined);
  const quickMenu = useBlockMenu(disabled, 300, insertMenuRect);
  const [pickerRequest, setPickerRequest] = useState<string | null>(null);
  const [keyboardMenuRequest, setKeyboardMenuRequest] = useState<string | null>(null);
  const [recordConversion, setRecordConversion] = useState<RecordConversion | null>(null);
  const [notice, setNotice] = useState('');
  const consumePickerRequest = useCallback(() => setPickerRequest(null), []);
  const consumeMenuRequest = useCallback(() => setKeyboardMenuRequest(null), []);
  const requestRecordConversion = useCallback((request: RecordConversion) => {
    if (!disabled) setRecordConversion(request);
  }, [disabled]);
  const openInsertMenu = useCallback((blockId: string, rect: DOMRect) => {
    if (disabled) return;
    insertAnchor.current = blockId; setInsertMenuRect(rect); quickMenu.setOpen(true);
  }, [disabled, quickMenu.setOpen]);
  const context = useMemo(() => ({ catalog, disabled, pickerRequest, consumePickerRequest, keyboardMenuRequest, consumeMenuRequest, requestRecordConversion, canManageRecords, onManageRecord, openInsertMenu }), [catalog, disabled, pickerRequest, consumePickerRequest, keyboardMenuRequest, consumeMenuRequest, requestRecordConversion, canManageRecords, onManageRecord, openInsertMenu]);
  const menuGroups = ['新建', '已有课程内容', '基础内容', '图文内容', '多项内容一起展示'];
  const hasPublishedPages = catalog.pages?.some(page => page.visibilityStatus === 'PUBLISHED');
  const availableOptions = [...(canManageRecords && onManageRecord ? createOptions : []), ...insertOptions]
    .filter(option => option.props?.kind !== 'pages' || hasPublishedPages).sort((a, b) => menuGroups.indexOf(a.group) - menuGroups.indexOf(b.group));

  useEffect(() => {
    if (disabled) { editor.getExtension(SideMenuExtension)?.unfreezeMenu(); setRecordConversion(null); }
  }, [disabled, editor]);
  useEffect(() => {
    onReady?.({ insertRecord: (request, recordId) => {
      // A record save does not replace this editor or its undo history.
      if (editor.getBlock(request.blockId)) return;
      const anchor = (request.afterBlockId && editor.getBlock(request.afterBlockId)) || editor.document.at(-1);
      if (!anchor) return;
      editor.insertBlocks([{ id: request.blockId, type: 'courseRecord', props: { kind: request.kind, recordId, display: 'card' } } as EditorBlock], anchor, 'after');
      setNotice('引用已插入；发布页面后仍按记录状态显示。');
    } });
    return () => onReady?.(null);
  }, [editor, onReady]);

  function changed() {
    // The JSON shape is shared with the server; omit BlockNote's undefined defaults.
    const blocks = normalizePastedColors(JSON.parse(JSON.stringify(editor.document)) as CourseBlock[]);
    onChange({ version: 1, blocks: markdownLayoutBlocks(blocks, false) });
  }
  function insert(option: InsertOption) {
    if (disabled) return;
    if (option.createKind) { createRecord(option.createKind, editor.getTextCursorPosition().block.id); return; }
    if (option.props?.kind === 'pages') {
      setRecordConversion({ blockId: editor.getTextCursorPosition().block.id, kind: 'pages', insertVia: 'slash' });
      editor.getExtension(SuggestionMenu)?.closeMenu();
      return;
    }
    const block = { type: option.type, props: option.props, content: option.content } as EditorBlock;
    const inserted = insertOrUpdateBlockForSlashMenu(editor, block);
    if (option.type === 'courseRecord') setPickerRequest(inserted.id);
    editor.getExtension(SuggestionMenu)?.closeMenu();
    setNotice(`已插入${option.label}`);
  }
  function quickInsert(option: InsertOption) {
    if (disabled) return;
    if (option.createKind) { createRecord(option.createKind, insertAnchor.current); return; }
    const anchorId = insertAnchor.current;
    const anchor = anchorId ? editor.getBlock(anchorId) : editor.document.at(-1);
    if (!anchor) return;
    quickMenu.setOpen(false); interactions.clearRange();
    if (option.props?.kind === 'pages') {
      setRecordConversion({ blockId: anchor.id, kind: 'pages', insertVia: 'toolbar' });
      return;
    }
    const inserted = insertAtAnchor(editor, anchor.id, { type: option.type, props: option.props, content: option.content } as EditorBlock);
    if (!inserted) return;
    if (option.type === 'courseRecord') setPickerRequest(inserted.id);
    else { editor.setTextCursorPosition(inserted, 'start'); editor.focus(); }
    setNotice(`已在当前位置添加${option.label}`);
  }
  function createRecord(kind: 'assignments' | 'resources', afterBlockId?: string) {
    if (disabled || !canManageRecords || !onManageRecord) return;
    quickMenu.setOpen(false); editor.getExtension(SuggestionMenu)?.closeMenu();
    onManageRecord({ blockId: crypto.randomUUID(), kind, afterBlockId: afterBlockId ?? interactions.insertionAnchor() });
  }
  function continueWriting() {
    if (disabled) return;
    const last = editor.document.at(-1);
    if (!last) return;
    const paragraph = last.type === 'paragraph' && last.content.length === 0 && last.children.length === 0
      ? last
      : editor.insertBlocks([{ type: 'paragraph' }], last, 'after')[0];
    editor.setTextCursorPosition(paragraph, 'start');
    editor.focus();
  }
  function showSideMenu(blockId: string, keyboard = false) {
    if (disabled) return;
    const block = editor.getBlock(blockId);
    const sideMenu = editor.getExtension(SideMenuExtension);
    const element = editor.domElement?.querySelector<HTMLElement>(`[data-node-type="blockContainer"][data-id="${CSS.escape(blockId)}"]`);
    if (!block || !element || !sideMenu || sideMenu.menuFrozen) return;
    sideMenu.store.setState({ show: true, block, referencePos: element.getBoundingClientRect() });
    if (keyboard) setKeyboardMenuRequest(block.id);
  }
  const insertButton = <button type="button" ref={quickMenu.triggerRef} className={styles.insertButton} disabled={disabled} aria-haspopup="dialog" aria-expanded={quickMenu.open} onPointerDown={() => interactions.rememberSelection()} onClick={() => {
    insertAnchor.current = interactions.insertionAnchor(); setInsertMenuRect(undefined); quickMenu.setOpen(value => !value);
  }}><CourseContentIcon name="plus" size={16}/>插入</button>;
  return <CatalogContext.Provider value={context}><CourseInteractionContext.Provider value={interactions}><div className={styles.editor} data-range-picking={interactions.picking || undefined} aria-keyshortcuts="Alt+Shift+B" onClickCapture={interactions.captureClick} onMouseDownCapture={interactions.captureMouse} onDragStartCapture={interactions.captureDrag} onPointerDownCapture={event => {
    interactions.capturePointer(event);
    if (event.isPropagationStopped()) return;
    if (event.pointerType === 'mouse' || !(event.target instanceof Element)) return;
    const id = event.target.closest('[data-node-type="blockContainer"]')?.getAttribute('data-id');
    if (id) showSideMenu(id);
  }} onKeyDownCapture={event => {
    if (event.altKey && event.shiftKey && event.code === 'KeyB' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      const target = event.target instanceof Element ? event.target : null;
      const id = target?.closest('[data-node-type="blockContainer"]')?.getAttribute('data-id');
      if (!id && target?.closest('[role="dialog"]')) return;
      event.preventDefault(); event.stopPropagation(); showSideMenu(id || editor.getTextCursorPosition().block.id, true);
    }
  }}>
    {toolbarHost ? createPortal(insertButton, toolbarHost) : <div className={styles.insertFallback}>{insertButton}</div>}
    <BlockMenu menu={quickMenu} label="插入内容">{menuGroups.map(group => {
      const options = availableOptions.filter(option => option.group === group);
      return options.length ? <div className={styles.insertGroup} key={group}><p>{group}</p><div className={styles.menuItems}>{options.map(option => <button type="button" key={option.label} disabled={disabled} onClick={() => quickInsert(option)}><CourseContentIcon name={option.icon} size={17}/>{option.label}</button>)}</div></div> : null;
    })}</BlockMenu>
    <CourseRangeTools editor={editor} interactions={interactions}/>
    <BlockNoteView editor={editor} editable={!disabled} theme="light" slashMenu={false} sideMenu={false} formattingToolbar={!interactions.picking && !interactions.rangeSelected && !interactions.dragging && !interactions.marquee} onChange={changed}>
      <SuggestionMenuController triggerCharacter="/" getItems={async query => filterSuggestionItems(availableOptions.map(option => ({ title: option.label, subtext: option.subtext, group: option.group, aliases: option.aliases, icon: <CourseContentIcon name={option.icon} size={18}/>, onItemClick: () => insert(option) })), query)}/>
      {!disabled && !interactions.marquee && <CourseSideMenuController/>}
    </BlockNoteView>
    {recordConversion && !disabled && <RecordConversionDialog key={`${recordConversion.blockId}-${recordConversion.kind}`} request={recordConversion} editor={editor} catalog={catalog} disabled={disabled} onCancel={() => {
      const source = editor.getBlock(recordConversion.blockId);
      setRecordConversion(null);
      if (source && textBlockTypes.has(source.type)) { editor.setTextCursorPosition(source, 'end'); editor.focus(); }
      else quickMenu.triggerRef.current?.focus({ preventScroll: true });
    }} onConverted={kind => { setRecordConversion(null); setNotice(`已关联${kindNames[kind]}，请保存页面。`); }}/>}
    <div className={styles.quietTools}><button type="button" className={styles.continueWriting} disabled={disabled} onClick={continueWriting}><CourseContentIcon name="plus" size={16}/>继续写作</button></div>
    <span className={styles.srOnly}>按 Alt + Shift + B 打开当前内容块的操作菜单。</span>
    <span className={styles.srOnly} aria-live="polite">{notice}</span>
  </div></CourseInteractionContext.Provider></CatalogContext.Provider>;
}
