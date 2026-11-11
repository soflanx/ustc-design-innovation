import { Fragment, Slice, type Node as ProseMirrorNode, type ResolvedPos } from '@tiptap/pm/model';
import { NodeSelection, Selection, type SelectionBookmark } from '@tiptap/pm/state';
import type { Mappable } from '@tiptap/pm/transform';

const selectionType = 'course-whole-blocks-v1';

function isBlock(node: ProseMirrorNode) {
  return node.type.name === 'blockContainer' && typeof node.attrs.id === 'string';
}

function nodesInRange($from: ResolvedPos, $to: ResolvedPos): ProseMirrorNode[] {
  if (!$from.sameParent($to) || $from.pos >= $to.pos) throw new RangeError('只能选择同一层级的一段连续内容。');
  const nodes: ProseMirrorNode[] = [];
  for (let pos = $from.pos; pos < $to.pos;) {
    const node = $from.doc.nodeAt(pos);
    if (!node || !isBlock(node) || pos + node.nodeSize > $to.pos) throw new RangeError('选区必须包含完整内容块。');
    nodes.push(node);
    pos += node.nodeSize;
  }
  return nodes;
}

function near(doc: ProseMirrorNode, pos: number) {
  return Selection.near(doc.resolve(Math.max(0, Math.min(doc.content.size, pos))));
}

function resolveRange(doc: ProseMirrorNode, from: number, to: number): Selection {
  if (from >= to || from < 0 || to > doc.content.size) return near(doc, from);
  try {
    const nodes = nodesInRange(doc.resolve(from), doc.resolve(to));
    return nodes.length === 1 ? NodeSelection.create(doc, from) : new WholeBlockSelection(doc.resolve(from), doc.resolve(to));
  } catch { return near(doc, from); }
}

/** A contiguous sibling range, including each selected block's entire subtree. */
export class WholeBlockSelection extends Selection {
  readonly nodes: readonly ProseMirrorNode[];

  constructor($from: ResolvedPos, $to: ResolvedPos) {
    super($from, $to);
    this.nodes = nodesInRange($from, $to);
  }

  content(): Slice {
    return new Slice(Fragment.fromArray([...this.nodes]), 0, 0);
  }

  eq(other: Selection): boolean {
    return other instanceof WholeBlockSelection && other.from === this.from && other.to === this.to;
  }

  map(doc: ProseMirrorNode, mapping: Mappable): Selection {
    // Exclude insertions exactly outside the selected range. Deleting some
    // selected nodes may leave a smaller valid range; deleting all collapses it.
    return resolveRange(doc, mapping.map(this.from, 1), mapping.map(this.to, -1));
  }

  toJSON() {
    return { type: selectionType, anchor: this.from, head: this.to };
  }

  static fromJSON(doc: ProseMirrorNode, value: { anchor?: unknown; head?: unknown }): Selection {
    if (!Number.isInteger(value.anchor) || !Number.isInteger(value.head)) throw new RangeError('内容块选区格式无效。');
    return new WholeBlockSelection(doc.resolve(value.anchor as number), doc.resolve(value.head as number));
  }

  getBookmark(): SelectionBookmark {
    return new WholeBlockBookmark(this.from, this.to);
  }
}

class WholeBlockBookmark implements SelectionBookmark {
  constructor(readonly from: number, readonly to: number) {}
  map(mapping: Mappable): SelectionBookmark {
    return new WholeBlockBookmark(mapping.map(this.from, 1), mapping.map(this.to, -1));
  }
  resolve(doc: ProseMirrorNode): Selection {
    return resolveRange(doc, this.from, this.to);
  }
}

// Fast Refresh can evaluate this module again while ProseMirror's JSON registry
// survives. Existing bookmarks remain valid; only the duplicate registration is ignored.
try { Selection.jsonID(selectionType, WholeBlockSelection); }
catch (error) {
  if (!(error instanceof RangeError) || !error.message.startsWith('Duplicate use of selection JSON ID')) throw error;
}

export function createCourseBlockSelection(doc: ProseMirrorNode, firstId: string, lastId = firstId): Selection {
  const found = new Map<string, { node: ProseMirrorNode; pos: number }>();
  doc.descendants((node, pos) => {
    if (isBlock(node) && (node.attrs.id === firstId || node.attrs.id === lastId)) found.set(node.attrs.id, { node, pos });
  });
  const first = found.get(firstId), last = found.get(lastId);
  if (!first || !last) throw new RangeError('要选择的内容块已经不存在。');
  if (firstId === lastId) return NodeSelection.create(doc, first.pos);
  const start = first.pos < last.pos ? first : last;
  const end = first.pos < last.pos ? last : first;
  return new WholeBlockSelection(doc.resolve(start.pos), doc.resolve(end.pos + end.node.nodeSize));
}

/** Actual whole-block drag roots, not partial text and not duplicate descendants. */
export function selectedCourseBlockIds(selection: Selection): string[] {
  if (selection.empty) return [];
  const doc = selection.$from.doc;
  let from = selection.from, to = selection.to;

  if (selection instanceof NodeSelection && !isBlock(selection.node)) {
    // Non-inline references/images may select their content node instead of its wrapper.
    for (let depth = selection.$from.depth; depth > 0; depth--) {
      const ancestor = selection.$from.node(depth);
      if (isBlock(ancestor)) return [ancestor.attrs.id];
    }
  }

  // Match BlockNote's dragStart expansion: dragging a text selection spanning
  // nesting levels moves the outer blocks at their common level, with children.
  if (selection.$from.parent.type.isInGroup('blockContent') && selection.$to.parent.type.isInGroup('blockContent')) {
    const depth = Math.min(selection.$anchor.depth, selection.$head.depth) - 1;
    if (depth > 0) {
      from = selection.$from.start(depth) - 1;
      to = selection.$to.end(depth) + 1;
    }
  }

  const ids: string[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!isBlock(node) || pos < from || pos + node.nodeSize > to) return true;
    ids.push(node.attrs.id);
    return false;
  });
  return ids;
}
