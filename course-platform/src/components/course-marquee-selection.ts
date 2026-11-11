'use client';

import { useEffect, useRef, useState } from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import { Selection } from '@tiptap/pm/state';
import { marqueeBlockRange, marqueeRectangle, marqueeScrollDelta } from '@/lib/course-marquee';
import styles from './course-block-editor.module.css';

type Editor = BlockNoteEditor<any, any, any>;
type MarqueeOptions = {
  disabled: boolean;
  canStart: () => boolean;
  onStart: () => void;
  onSelect: (ids: string[]) => void;
  onFinish: (cancelled: boolean) => void;
};

const controls = 'button, a, input, textarea, select, summary, [role="button"], [role="dialog"], [role="menu"], [data-course-editor-toolbar], [data-course-selected], [draggable="true"]';
const textTypes = new Set(['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'quote']);

/** Only blank page space starts a box. Text, links, cards and controls keep their gestures. */
function blankAt(target: Element, x: number, y: number): boolean {
  if (target.closest(controls)) return false;
  const content = target.closest<HTMLElement>('.bn-block-content');
  if (!content) return true;
  if (!textTypes.has(content.dataset.contentType ?? '')) return false;
  // A line is full-width in the DOM, but the blank after its text is still page space.
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.textContent?.length) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 3 && y <= rect.bottom + 3) return false;
    }
  }
  return true;
}

export function useCourseMarqueeSelection(editor: Editor, options: MarqueeOptions): boolean {
  const [selecting, setSelecting] = useState(false);
  const latest = useRef(options); latest.current = options;
  useEffect(() => {
    if (options.disabled) return;
    const root = editor.domElement;
    const surface = root?.closest<HTMLElement>('[data-course-selection-surface]');
    if (!root || !surface) return;
    let gesture: {
      pointerId: number; startX: number; startY: number; clientX: number; clientY: number;
      initialClientX: number; initialClientY: number; active: boolean; ids: string[];
    } | null = null;
    let box: HTMLDivElement | null = null;
    let frame = 0;
    let clickUntil = 0;
    let lastFrameTime = 0;

    const topBlocks = () => editor.document.flatMap(block => {
      const element = root.querySelector<HTMLElement>(`[data-node-type="blockContainer"][data-id="${CSS.escape(block.id)}"]`);
      if (!element) return [];
      const rect = element.getBoundingClientRect();
      return rect.width && rect.height ? [{ id: block.id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }] : [];
    });
    function paint() {
      if (!gesture?.active || !box) return;
      const rectangle = marqueeRectangle({ x: gesture.startX - window.scrollX, y: gesture.startY - window.scrollY }, { x: gesture.clientX, y: gesture.clientY });
      const toolbar = surface!.querySelector<HTMLElement>('[data-course-editor-toolbar]')?.getBoundingClientRect();
      const visibleTop = Math.max(rectangle.top, 0, toolbar?.bottom ?? 0);
      const visibleBottom = Math.min(rectangle.bottom, window.innerHeight, root!.getBoundingClientRect().bottom);
      Object.assign(box.style, { left: `${rectangle.left}px`, top: `${visibleTop}px`, width: `${rectangle.right - rectangle.left}px`, height: `${Math.max(0, visibleBottom - visibleTop)}px` });
      const ids = marqueeBlockRange(rectangle, topBlocks());
      if (ids.join() !== gesture.ids.join()) { gesture.ids = ids; latest.current.onSelect(ids); }
    }
    function scroll(time: number) {
      frame = 0;
      if (!gesture?.active) return;
      // This canvas scrolls with the document. The anchor remains in document coordinates.
      const rect = surface!.getBoundingClientRect();
      const toolbar = surface!.querySelector<HTMLElement>('[data-course-editor-toolbar]')?.getBoundingClientRect();
      const top = Math.max(0, rect.top, toolbar?.bottom ?? 0);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      const scale = lastFrameTime ? Math.min(2, (time - lastFrameTime) / (1000 / 60)) : 1;
      lastFrameTime = time;
      const delta = marqueeScrollDelta(gesture.clientY, top, bottom) * scale;
      if (delta) window.scrollBy({ top: delta, behavior: 'instant' });
      paint();
      frame = requestAnimationFrame(scroll);
    }
    function finish(cancelled: boolean, focus = true) {
      const previous = gesture;
      if (!previous) return;
      gesture = null;
      cancelAnimationFrame(frame); frame = 0; lastFrameTime = 0;
      box?.remove(); box = null;
      surface!.classList.remove(styles.marqueeSelecting);
      delete surface!.dataset.courseMarqueeActive;
      if (surface!.hasPointerCapture(previous.pointerId)) surface!.releasePointerCapture(previous.pointerId);
      setSelecting(false);
      if (previous.active) {
        clickUntil = performance.now() + 200;
        latest.current.onFinish(cancelled);
        // Focus without the editor's default scroll-to-caret jumping the selected range.
        if (!cancelled && focus) root!.focus({ preventScroll: true });
      } else if (!cancelled && focus) {
        latest.current.onSelect([]);
        // A click in blank space still places the caret; only a drag selects blocks.
        const bounds = root!.getBoundingClientRect();
        const hit = editor.prosemirrorView.posAtCoords({ left: Math.max(bounds.left + 1, Math.min(previous.clientX, bounds.right - 1)), top: previous.clientY });
        if (hit) editor.prosemirrorView.dispatch(editor.prosemirrorState.tr.setSelection(Selection.near(editor.prosemirrorState.doc.resolve(hit.pos))));
        root!.focus({ preventScroll: true });
      } else if (cancelled) latest.current.onFinish(true);
    }
    function down(event: globalThis.PointerEvent) {
      if (latest.current.disabled || !latest.current.canStart() || gesture || event.button !== 0 || event.pointerType !== 'mouse' || !event.isPrimary || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(event.target instanceof Element)) return;
      const bounds = root!.getBoundingClientRect();
      if (!bounds.height || event.clientY < bounds.top || event.clientY > bounds.bottom || !blankAt(event.target, event.clientX, event.clientY)) return;
      event.preventDefault(); event.stopPropagation();
      gesture = { pointerId: event.pointerId, startX: event.clientX + window.scrollX, startY: event.clientY + window.scrollY, clientX: event.clientX, clientY: event.clientY, initialClientX: event.clientX, initialClientY: event.clientY, active: false, ids: [] };
      surface!.setPointerCapture(event.pointerId);
    }
    function move(event: globalThis.PointerEvent) {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) { finish(false); return; }
      gesture.clientX = event.clientX; gesture.clientY = event.clientY;
      if (!gesture.active && Math.hypot(event.clientX - gesture.initialClientX, event.clientY - gesture.initialClientY) < 5) return;
      event.preventDefault(); event.stopPropagation();
      if (!gesture.active) {
        gesture.active = true;
        latest.current.onStart();
        window.getSelection()?.removeAllRanges();
        surface!.classList.add(styles.marqueeSelecting);
        surface!.dataset.courseMarqueeActive = '';
        box = document.createElement('div'); box.className = styles.marqueeBox;
        box.dataset.courseMarquee = ''; box.setAttribute('aria-hidden', 'true'); document.body.appendChild(box);
        setSelecting(true);
        frame = requestAnimationFrame(scroll);
      }
      paint();
    }
    function up(event: globalThis.PointerEvent) {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gesture.clientX = event.clientX; gesture.clientY = event.clientY; paint(); finish(false);
    }
    const cancel = () => finish(true, false);
    const escape = (event: KeyboardEvent) => {
      if (gesture && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    const click = (event: globalThis.MouseEvent) => {
      if (performance.now() < clickUntil && event.detail > 0) { clickUntil = 0; event.preventDefault(); event.stopPropagation(); }
    };
    surface.addEventListener('pointerdown', down, true);
    surface.addEventListener('lostpointercapture', cancel);
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancel); window.addEventListener('keydown', escape, true);
    window.addEventListener('scroll', paint, true); surface.addEventListener('click', click, true);
    return () => {
      finish(true, false);
      surface.removeEventListener('pointerdown', down, true); surface.removeEventListener('lostpointercapture', cancel);
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape, true); window.removeEventListener('scroll', paint, true); surface.removeEventListener('click', click, true);
    };
  }, [editor, options.disabled]);
  return selecting;
}
