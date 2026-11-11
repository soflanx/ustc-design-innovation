'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { CourseDocument } from '@/lib/course-document';
import { canDropWritingObject, dropWritingObject, type WritingDrop } from '@/lib/course-markdown-edit';

type Point = { x: number; y: number };
type Press = { id: string; pointer: number; origin: Point; current: Point; doc: CourseDocument; moved: boolean; label: string };
type Feedback = { x: number; y: number; line: number | null; label: string };

function nearestDrop(root: HTMLElement, point: Point) {
  const bounds = root.getBoundingClientRect();
  if (point.x < bounds.left - 32 || point.x > bounds.right + 8 || point.y < bounds.top - 6 || point.y > bounds.bottom + 6) return;
  let nearest: { at: WritingDrop; distance: number; line: number } | undefined;
  for (const marker of root.querySelectorAll<HTMLElement>('[data-writing-drop]')) {
    const edge = marker.dataset.writingEdge;
    if (edge) {
      const scroll = marker.parentElement?.querySelector<HTMLElement>('[data-writing-scroll]');
      if (scroll && (edge === 'start' ? scroll.scrollTop > 1 : scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - 1)) continue;
    }
    const top = marker.getBoundingClientRect().top;
    const clip = marker.closest('[data-writing-scroll]')?.getBoundingClientRect();
    if (clip && (top < clip.top || top > clip.bottom)) continue;
    const distance = Math.abs(point.y - top);
    if (!nearest || distance < nearest.distance) {
      const [index, offset] = marker.dataset.writingDrop!.split(':').map(Number);
      nearest = { at: { index, offset }, distance, line: top - bounds.top };
    }
  }
  return nearest;
}

export function useWritingObjectDrag(root: RefObject<HTMLDivElement | null>, doc: CourseDocument, disabled: boolean,
  onDrop: (next: CourseDocument, id: string) => void, onStart: () => void) {
  const press = useRef<Press | null>(null);
  const ignoreClick = useRef(false);
  const [active, setActive] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  function cancel() {
    if (press.current?.moved) ignoreClick.current = true;
    press.current = null;
    setActive(null); setFeedback(null);
  }

  useEffect(() => {
    if (!active) return;
    if (disabled || press.current?.doc !== doc) { cancel(); return; }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape, true);
    let frame = 0;
    let lastPosition = '', lastKey = '', allowed = false;
    const tick = () => {
      const session = press.current, body = root.current;
      if (!session || !body) return;
      const { x, y } = session.current;
      const viewport = window.innerHeight;
      const bounds = body.getBoundingClientRect();
      const scroller = window.document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-writing-scroll]');
      const scrollBounds = scroller?.getBoundingClientRect();
      const before = scroller?.scrollTop ?? 0;
      if (scroller && scrollBounds && scroller.scrollHeight > scroller.clientHeight + 1) {
        const step = y < scrollBounds.top + 32 ? -8 : y > scrollBounds.bottom - 32 ? 8 : 0;
        if (step) scroller.scrollTop += step;
      }
      if (before === (scroller?.scrollTop ?? 0) && x >= bounds.left - 32 && x <= bounds.right + 8) {
        const speed = y < 54 ? -Math.ceil((54 - y) / 4) : y > viewport - 54 ? Math.ceil((y - viewport + 54) / 4) : 0;
        if (speed) window.scrollBy(0, Math.max(-18, Math.min(18, speed)));
      }
      const position = [x, y, bounds.top, bounds.width, window.scrollY, scroller?.scrollTop].join('/');
      if (lastPosition !== position) {
        const drop = nearestDrop(body, session.current);
        const key = drop ? drop.at.index + ':' + drop.at.offset : '';
        if (lastKey !== key) { lastKey = key; allowed = !!drop && canDropWritingObject(doc, session.id, drop.at); }
        setFeedback({ x, y, label: session.label, line: drop && allowed ? drop.line : null });
        lastPosition = position;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', escape, true);
    };
  }, [active, doc, disabled, root]);

  function pointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string, label: string) {
    if (disabled || !event.isPrimary || event.button !== 0) return;
    ignoreClick.current = false;
    const point = { x: event.clientX, y: event.clientY };
    press.current = { id, pointer: event.pointerId, origin: point, current: point, doc, moved: false, label };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const session = press.current;
    if (!session || event.pointerId !== session.pointer) return;
    session.current = { x: event.clientX, y: event.clientY };
    if (!session.moved && Math.hypot(event.clientX - session.origin.x, event.clientY - session.origin.y) >= 5) {
      session.moved = true; setActive(session.id); onStart();
    }
  }

  function pointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const session = press.current;
    if (!session || event.pointerId !== session.pointer) return;
    if (session.moved && root.current && !disabled && doc === session.doc) {
      const target = nearestDrop(root.current, { x: event.clientX, y: event.clientY });
      if (target) {
        const next = dropWritingObject(doc, session.id, target.at);
        if (next !== doc) onDrop(next, session.id);
      }
    }
    cancel();
  }
  function consumeDragClick() {
    const consumed = ignoreClick.current;
    ignoreClick.current = false;
    return consumed;
  }
  return { active, feedback, pointerDown, pointerMove, pointerUp, cancel, consumeDragClick };
}
