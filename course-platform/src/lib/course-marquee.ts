export type Point = { x: number; y: number };
export type Rect = { left: number; top: number; right: number; bottom: number };

/** Both points use the same coordinate space; dragging backwards is equivalent. */
export function marqueeRectangle(start: Point, end: Point): Rect {
  return {
    left: Math.min(start.x, end.x), top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y),
  };
}

/**
 * The caller supplies root blocks in document order, with each subtree included
 * in its root's bounds. Keep the resulting range contiguous for whole-block moves.
 */
export function marqueeBlockRange(rect: Rect, blocks: readonly (Rect & { id: string })[]): string[] {
  if (![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)
    || rect.right <= rect.left || rect.bottom <= rect.top) return [];
  let first = -1, last = -1;
  blocks.forEach((block, index) => {
    const overlaps = Math.min(rect.right, block.right) > Math.max(rect.left, block.left)
      && Math.min(rect.bottom, block.bottom) > Math.max(rect.top, block.top);
    if (!overlaps) return;
    if (first === -1) first = index;
    last = index;
  });
  return first === -1 ? [] : blocks.slice(first, last + 1).map(block => block.id);
}

/** Pixels per animation frame, with a linear 56px edge zone and an 18px cap. */
export function marqueeScrollDelta(pointerY: number, viewportTop: number, viewportBottom: number): number {
  if (![pointerY, viewportTop, viewportBottom].every(Number.isFinite) || viewportBottom <= viewportTop) return 0;
  // Tiny viewports should still have a neutral midpoint rather than overlapping zones.
  const edge = Math.min(56, (viewportBottom - viewportTop) / 2);
  if (pointerY < viewportTop + edge) return -18 * Math.min(1, (viewportTop + edge - pointerY) / edge);
  if (pointerY > viewportBottom - edge) return 18 * Math.min(1, (pointerY - viewportBottom + edge) / edge);
  return 0;
}
