'use client';

import { createContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BlockNoteEditor } from '@blocknote/core';
import { SideMenuExtension } from '@blocknote/core/extensions';
import { Selection, type SelectionBookmark } from '@tiptap/pm/state';
import { createCourseBlockSelection, selectedCourseBlockIds, WholeBlockSelection } from '@/lib/course-block-selection';
import { CourseContentIcon } from './course-content-icon';
import { useCourseMarqueeSelection } from './course-marquee-selection';
import styles from './course-block-editor.module.css';

type Editor = BlockNoteEditor<any, any, any>;
type SavedSelection = { doc: Editor['prosemirrorState']['doc']; bookmark: SelectionBookmark };

const blockElement = (editor: Editor, id: string) => editor.domElement?.querySelector<HTMLElement>(`[data-node-type="blockContainer"][data-id="${CSS.escape(id)}"]`);

export type CourseInteractions = {
  picking: boolean; startId: string | null; selectedIds: string[]; dragging: boolean; rangeSelected: boolean; marquee: boolean;
  beginRange: (startBlockId?: string) => void; clearRange: () => void;
  capturePointer: (event: PointerEvent<HTMLElement>) => void;
  captureClick: (event: MouseEvent<HTMLElement>) => void;
  captureMouse: (event: MouseEvent<HTMLElement>) => void;
  captureDrag: (event: DragEvent<HTMLElement>) => void;
  rememberSelection: () => void;
  startDrag: (event: DragEvent<HTMLElement>, blockId?: string) => void;
  endDrag: () => void;
  insertionAnchor: () => string | undefined;
};
export const CourseInteractionContext = createContext<CourseInteractions | null>(null);

export function useCourseEditorInteractions(editor: Editor, disabled: boolean): CourseInteractions {
  const [picking, setPicking] = useState(false);
  const [startId, setStartId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const explicitIds = useRef<string[]>([]);
  const savedSelection = useRef<SavedSelection | null>(null);
  const dragActive = useRef(false);
  const preview = useRef<HTMLDivElement | null>(null);
  const ghost = useRef<HTMLCanvasElement | null>(null);
  const rangeFrame = useRef<HTMLDivElement | null>(null);
  const dragRoots = useRef<string[]>([]);
  const located = useRef(false);
  const suppressClick = useRef(false);
  const pressedRangeId = useRef<string | null>(null);
  const draggableElements = useRef(new Map<HTMLElement, string | null>());

  function rememberSelection() {
    const state = editor.prosemirrorState;
    savedSelection.current = { doc: state.doc, bookmark: state.selection.getBookmark() };
  }
  function restoreSelection() {
    const saved = savedSelection.current;
    // A pointer press does not change the document. Never restore an old range
    // over content changed by editing, Undo, or another operation.
    if (saved && saved.doc === editor.prosemirrorState.doc) {
      const selection = saved.bookmark.resolve(editor.prosemirrorState.doc);
      editor.prosemirrorView.dispatch(editor.prosemirrorState.tr.setSelection(selection));
    }
  }
  function clearPaint() {
    draggableElements.current.forEach((value, element) => {
      if (value === null) element.removeAttribute('draggable'); else element.setAttribute('draggable', value);
    });
    draggableElements.current.clear();
    editor.domElement?.querySelectorAll<HTMLElement>('[data-course-selected], [data-course-dragging]').forEach(element => {
      delete element.dataset.courseSelected; delete element.dataset.courseDragging;
    });
    rangeFrame.current?.remove(); rangeFrame.current = null;
  }
  function clearRange() {
    pressedRangeId.current = null;
    explicitIds.current = []; savedSelection.current = null;
    setPicking(false); setStartId(null); setSelectedIds([]); clearPaint();
    if (!dragActive.current && !editor.prosemirrorState.selection.empty) {
      editor.prosemirrorView.dispatch(editor.prosemirrorState.tr.setSelection(Selection.near(editor.prosemirrorState.selection.$from)));
    }
  }
  function updateRangeFrame(ids: string[], isDragging: boolean) {
    const elements = ids.map(id => blockElement(editor, id)).filter((element): element is HTMLElement => !!element);
    if (!elements.length) { rangeFrame.current?.remove(); rangeFrame.current = null; return; }
    const bounds = elements.map(element => element.getBoundingClientRect());
    const left = Math.min(...bounds.map(rect => rect.left));
    const right = Math.max(...bounds.map(rect => rect.right));
    const top = Math.min(...bounds.map(rect => rect.top));
    const bottom = Math.max(...bounds.map(rect => rect.bottom));
    if (!rangeFrame.current) {
      rangeFrame.current = document.createElement('div');
      rangeFrame.current.className = styles.selectionFrame;
      rangeFrame.current.setAttribute('aria-hidden', 'true');
      document.body.appendChild(rangeFrame.current);
    }
    Object.assign(rangeFrame.current.style, { left: `${left - 5}px`, top: `${top - 3}px`, width: `${right - left + 10}px`, height: `${bottom - top + 6}px` });
    rangeFrame.current.dataset.dragging = String(isDragging);
  }
  function removeDragVisuals() {
    preview.current?.remove(); preview.current = null;
    ghost.current?.remove(); ghost.current = null;
    dragRoots.current = [];
    editor.domElement?.querySelectorAll<HTMLElement>('[data-course-dragging]').forEach(element => delete element.dataset.courseDragging);
  }
  function endDrag() {
    if (!dragActive.current) return;
    dragActive.current = false;
    pressedRangeId.current = null;
    editor.getExtension(SideMenuExtension)?.blockDragEnd();
    editor.prosemirrorView.dragging = null;
    removeDragVisuals();
    setDragging(false);
    clearRange();
  }
  function movePreview(x: number, y: number) {
    const element = preview.current;
    if (!element || (!x && !y)) return;
    const width = element.getBoundingClientRect().width;
    const height = element.getBoundingClientRect().height;
    const left = Math.max(8, Math.min(x + 18, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(y + 18, window.innerHeight - Math.min(height, 330) - 8));
    element.style.transform = `translate(${left}px, ${top}px)`;
  }
  function makePreview(ids: string[], event: DragEvent<HTMLElement>) {
    removeDragVisuals();
    dragRoots.current = ids;
    const floating = document.createElement('div');
    floating.className = `${styles.editor} ${styles.dragPreview}`;
    floating.setAttribute('aria-hidden', 'true');
    floating.inert = true;
    const label = document.createElement('div');
    label.className = styles.dragPreviewLabel;
    label.textContent = `正在移动 ${ids.length} 块内容${ids.some(id => editor.getBlock(id)?.children.length) ? '（含子内容）' : ''}`;
    floating.appendChild(label);
    const scope = document.createElement('div');
    scope.className = `bn-container ${styles.dragPreviewContent}`;
    // Never use BlockNote's editor-root class here: its drop discovery queries
    // every .bn-editor, including a visual clone rendered outside the editor.
    const canvas = document.createElement('div'); canvas.className = styles.dragPreviewCanvas;
    const group = document.createElement('div'); group.className = 'bn-block-group';
    group.dataset.nodeType = 'blockGroup';
    const all = ids.map(id => blockElement(editor, id)).filter((element): element is HTMLElement => !!element);
    all.forEach(element => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('iframe, embed, object, script').forEach(node => node.remove());
      [clone, ...clone.querySelectorAll<HTMLElement>('*')].forEach(node => {
        node.classList.remove('bn-editor', 'ProseMirror', 'bn-root');
        node.removeAttribute('id'); node.removeAttribute('name'); node.removeAttribute('form');
        node.removeAttribute('contenteditable'); node.removeAttribute('data-course-selected'); node.removeAttribute('data-course-dragging');
        node.removeAttribute('aria-controls'); node.removeAttribute('aria-labelledby');
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
          const text = document.createElement('span'); text.textContent = node.value; text.className = node.className; node.replaceWith(text);
        } else if (node instanceof HTMLButtonElement) { node.disabled = true; node.tabIndex = -1; }
      });
      group.appendChild(clone);
      element.dataset.courseDragging = '';
    });
    canvas.appendChild(group); scope.appendChild(canvas); floating.appendChild(scope);
    floating.style.width = `${Math.min(520, Math.max(260, all[0]?.getBoundingClientRect().width ?? 360), window.innerWidth - 24)}px`;
    document.body.appendChild(floating); preview.current = floating;
    movePreview(event.clientX, event.clientY);
    const blank = document.createElement('canvas'); blank.width = 1; blank.height = 1;
    Object.assign(blank.style, { position: 'fixed', left: '0', top: '0', pointerEvents: 'none' });
    document.body.appendChild(blank); ghost.current = blank;
    event.dataTransfer.setDragImage(blank, 0, 0);
    updateRangeFrame(ids, true);
  }
  function startDrag(event: DragEvent<HTMLElement>, blockId?: string) {
    if (disabled || picking) { event.preventDefault(); return; }
    restoreSelection();
    const view = editor.prosemirrorView;
    const rememberedIds = selectedCourseBlockIds(view.state.selection);
    const roots = explicitIds.current.length ? explicitIds.current : rememberedIds;
    const targetElement = blockId ? blockElement(editor, blockId) : undefined;
    const selectedParent = blockId && targetElement ? roots.find(root => blockElement(editor, root)?.contains(targetElement)) : undefined;
    const id = selectedParent || blockId || roots[0];
    const block = id ? editor.getBlock(id) : undefined;
    const sideMenu = editor.getExtension(SideMenuExtension);
    if (!block || !sideMenu) { event.preventDefault(); return; }
    const useWholeRange = roots.includes(block.id) && (explicitIds.current.length > 0 || view.state.selection instanceof WholeBlockSelection);
    if (useWholeRange) {
      // Initialize BlockNote's native drag origin/cleanup with one block first.
      view.dispatch(view.state.tr.setSelection(createCourseBlockSelection(view.state.doc, block.id)));
      sideMenu.blockDragStart(event, block);
      const selection = createCourseBlockSelection(view.state.doc, roots[0], roots.at(-1)!);
      view.dispatch(view.state.tr.setSelection(selection));
      const slice = selection.content();
      const blocks = roots.map(root => editor.getBlock(root)).filter(item => !!item);
      const html = editor.blocksToHTMLLossy(blocks);
      const inert = new DOMParser().parseFromString(html, 'text/html');
      event.dataTransfer.clearData();
      event.dataTransfer.setData('blocknote/html', view.serializeForClipboard(slice).dom.innerHTML);
      event.dataTransfer.setData('blocknote/parent', selection.$from.parent.type.name);
      event.dataTransfer.setData('text/html', html);
      event.dataTransfer.setData('text/plain', inert.body.textContent || '');
      event.dataTransfer.effectAllowed = 'move';
      view.dragging = { slice, move: true };
    } else {
      // Native text selections use BlockNote's own expansion to complete blocks.
      sideMenu.blockDragStart(event, block);
      view.dragging = { slice: view.state.selection.content(), move: true };
    }
    const actualIds = selectedCourseBlockIds(view.state.selection);
    explicitIds.current = [];
    dragActive.current = true; setDragging(true); setSelectedIds(actualIds);
    makePreview(actualIds, event);
  }
  function beginRange(startBlockId?: string) {
    if (disabled) return;
    clearRange(); setPicking(true);
    if (!startBlockId) return;
    let element = blockElement(editor, startBlockId);
    while (element?.parentElement?.closest('[data-node-type="blockContainer"]')) element = element.parentElement.closest<HTMLElement>('[data-node-type="blockContainer"]') ?? undefined;
    const topId = element?.dataset.id;
    if (!topId || !editor.document.some(block => block.id === topId)) return;
    const selection = createCourseBlockSelection(editor.prosemirrorState.doc, topId);
    explicitIds.current = [topId];
    editor.prosemirrorView.dispatch(editor.prosemirrorState.tr.setSelection(selection));
    setStartId(topId); setSelectedIds([topId]); rememberSelection();
  }
  function capturePointer(event: PointerEvent<HTMLElement>) {
    if (disabled || !(event.target instanceof Element) || !editor.domElement?.contains(event.target)) return;
    located.current = true;
    if (!picking) {
      const rootId = explicitIds.current.find(id => blockElement(editor, id)?.contains(event.target as Node));
      if (rootId && event.pointerType === 'mouse' && event.button === 0 && !event.target.closest('button, a, input, textarea, select, summary')) {
        pressedRangeId.current = rootId; rememberSelection(); return;
      }
      if (!dragActive.current) { pressedRangeId.current = null; explicitIds.current = []; setStartId(null); setSelectedIds([]); }
      return;
    }
    let element = event.target.closest<HTMLElement>('[data-node-type="blockContainer"]');
    while (element?.parentElement?.closest('[data-node-type="blockContainer"]')) element = element.parentElement.closest<HTMLElement>('[data-node-type="blockContainer"]');
    const id = element?.dataset.id;
    if (!id || !editor.document.some(block => block.id === id)) return;
    event.preventDefault(); event.stopPropagation();
    suppressClick.current = true;
    const selection = createCourseBlockSelection(editor.prosemirrorState.doc, startId ?? id, id);
    const ids = selectedCourseBlockIds(selection);
    explicitIds.current = ids;
    editor.prosemirrorView.dispatch(editor.prosemirrorState.tr.setSelection(selection));
    setSelectedIds(ids); rememberSelection();
    if (startId) { setPicking(false); setStartId(null); }
    else setStartId(id);
  }
  function captureClick(event: MouseEvent<HTMLElement>) {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    if (event.target instanceof Element && editor.domElement?.contains(event.target)) { event.preventDefault(); event.stopPropagation(); }
  }
  function captureMouse(event: MouseEvent<HTMLElement>) {
    // Keep ProseMirror from treating a press on the selected blocks as a new text selection.
    // Do not cancel the browser default: it starts the native HTML drag on the root block.
    if (pressedRangeId.current) event.stopPropagation();
  }
  function captureDrag(event: DragEvent<HTMLElement>) {
    if (!pressedRangeId.current || !explicitIds.current.length) return;
    event.stopPropagation();
    startDrag(event, pressedRangeId.current);
  }
  function insertionAnchor() {
    if (!located.current) return editor.document.at(-1)?.id;
    const ids = selectedCourseBlockIds(editor.prosemirrorState.selection);
    if (ids.length) return ids.at(-1);
    try { return editor.getTextCursorPosition().block.id; } catch { return editor.document.at(-1)?.id; }
  }

  const marquee = useCourseMarqueeSelection(editor, {
    disabled,
    canStart: () => !picking && !dragActive.current,
    onStart: () => {
      clearRange(); located.current = true;
      editor.getExtension(SideMenuExtension)?.unfreezeMenu();
    },
    onSelect: ids => {
      explicitIds.current = ids;
      setSelectedIds(ids);
      if (ids.length) {
        editor.prosemirrorView.dispatch(editor.prosemirrorState.tr.setSelection(createCourseBlockSelection(editor.prosemirrorState.doc, ids[0], ids.at(-1)!)));
        rememberSelection();
      } else clearRange();
    },
    onFinish: cancelled => { if (cancelled) clearRange(); else rememberSelection(); },
  });

  useEffect(() => {
    const update = () => {
      if (dragActive.current || pressedRangeId.current) return;
      if (editor.prosemirrorView.hasFocus()) located.current = true;
      const ids = selectedCourseBlockIds(editor.prosemirrorState.selection);
      setSelectedIds(ids);
      if (explicitIds.current.length) explicitIds.current = editor.prosemirrorState.selection instanceof WholeBlockSelection || ids.join() === explicitIds.current.join() ? ids : [];
    };
    const offSelection = editor.onSelectionChange(update);
    const offChange = editor.onChange(update);
    return () => { offSelection(); offChange(); };
  }, [editor]);
  const rangeSelected = explicitIds.current.length > 0;
  useLayoutEffect(() => {
    clearPaint();
    if (!picking && !rangeSelected && !dragging) return;
    selectedIds.forEach(id => { const element = blockElement(editor, id); if (element) {
      element.dataset.courseSelected = '';
      if (dragging) element.dataset.courseDragging = '';
      if (rangeSelected && !marquee) { draggableElements.current.set(element, element.getAttribute('draggable')); element.draggable = true; }
    } });
    if (selectedIds.length && !marquee) updateRangeFrame(selectedIds, dragging);
    const reposition = () => { if (selectedIds.length && !marquee) updateRangeFrame(selectedIds, dragging); };
    window.addEventListener('scroll', reposition, true); window.addEventListener('resize', reposition);
    return () => { window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition); };
  }, [editor, selectedIds, dragging, picking, rangeSelected, marquee]);
  useEffect(() => {
    const over = (event: globalThis.DragEvent) => { if (dragActive.current) { movePreview(event.clientX, event.clientY); updateRangeFrame(dragRoots.current, true); } };
    const finish = () => { if (dragActive.current) endDrag(); };
    const dropped = () => { if (dragActive.current) requestAnimationFrame(finish); };
    const escape = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
      if (event.key === 'Escape' && !event.isComposing && (picking || explicitIds.current.length || dragActive.current)) { if (dragActive.current) endDrag(); else clearRange(); }
    };
    document.addEventListener('dragover', over, true); document.addEventListener('drag', over, true);
    document.addEventListener('drop', dropped, true); document.addEventListener('dragend', finish, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('dragover', over, true); document.removeEventListener('drag', over, true);
      document.removeEventListener('drop', dropped, true); document.removeEventListener('dragend', finish, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [editor, picking]);
  useEffect(() => { if (disabled) { endDrag(); clearRange(); } }, [disabled]);
  useEffect(() => {
    const release = (event: globalThis.PointerEvent) => {
      if (!pressedRangeId.current || dragActive.current) return;
      pressedRangeId.current = null;
      const hit = editor.prosemirrorView.posAtCoords({ left: event.clientX, top: event.clientY });
      clearRange();
      if (hit) editor.prosemirrorView.dispatch(editor.prosemirrorState.tr.setSelection(Selection.near(editor.prosemirrorState.doc.resolve(hit.pos))));
    };
    const cancelPress = () => { pressedRangeId.current = null; };
    const blur = () => { cancelPress(); if (dragActive.current) endDrag(); };
    window.addEventListener('pointerup', release);
    // A native HTML drag emits pointercancel too, so it must keep the active drag intact.
    window.addEventListener('pointercancel', cancelPress); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', cancelPress); window.removeEventListener('blur', blur); };
  }, [editor]);
  useEffect(() => () => { removeDragVisuals(); clearPaint(); }, [editor]);
  return { picking, startId, selectedIds, dragging, rangeSelected, marquee, beginRange, clearRange, capturePointer, captureClick, captureMouse, captureDrag, rememberSelection, startDrag, endDrag, insertionAnchor };
}

/** Temporary controls belong to the selected content, without shifting the page. */
export function CourseRangeTools({ editor, interactions }: { editor: Editor; interactions: CourseInteractions }) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const visible = !interactions.marquee && (interactions.picking || interactions.rangeSelected || interactions.dragging);
  useLayoutEffect(() => {
    if (!visible) return;
    const update = () => {
      const firstId = interactions.selectedIds[0] ?? interactions.startId;
      const target = firstId ? blockElement(editor, firstId) : editor.domElement;
      const rect = target?.getBoundingClientRect();
      const floating = panel.current;
      if (!rect || !floating) return;
      const width = floating.offsetWidth, height = floating.offsetHeight;
      const viewWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewHeight = window.visualViewport?.height ?? window.innerHeight;
      const preferredTop = rect.top >= height + 16 ? rect.top - height - 7 : rect.bottom + 7;
      setPosition({ left: Math.max(8, Math.min(rect.left, viewWidth - width - 8)), top: Math.max(8, Math.min(preferredTop, viewHeight - height - 8)), visibility: 'visible' });
    };
    update(); window.addEventListener('scroll', update, true); window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); window.visualViewport?.removeEventListener('resize', update); };
  }, [editor, visible, interactions.selectedIds, interactions.startId, interactions.picking]);
  if (!visible) return null;
  return createPortal(<div ref={panel} className={styles.rangeTools} style={{ ...position, ...(interactions.dragging ? { opacity: 0, pointerEvents: 'none' } : {}) }} role="toolbar" aria-label="移动所选内容">
    {interactions.picking ? <span>{interactions.startId ? '点击最后一块' : '点击第一块'}</span> : <button type="button" className={styles.rangeDrag} draggable onPointerDown={interactions.rememberSelection} onDragStart={event => interactions.startDrag(event)} onDragEnd={interactions.endDrag}><CourseContentIcon name="grip" size={16}/>拖动 {interactions.selectedIds.length} 块</button>}
    <button type="button" className={styles.rangeCancel} onClick={interactions.clearRange}>取消</button>
  </div>, document.body);
}
