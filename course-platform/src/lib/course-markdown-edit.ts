import { Lexer } from 'marked';
import { createMarkdownBlock, readMarkdownSource, type CourseBlock, type CourseDocument } from './course-document';

type TextPart = { block: CourseBlock; source: string };
export type WritingArea = { type: 'text'; key: string; start: number; end: number; parts: TextPart[]; source: string };
type ObjectArea = { type: 'object'; key: string; index: number; block: CourseBlock };
type EditorArea = WritingArea | ObjectArea;
const paragraphBreak = '\n\n';

// Only project legacy content we can express faithfully. All other blocks
// remain intact in the document, including nested and protected references.
function textSource(block: CourseBlock): string | null {
  if (block.children?.length) return null;
  const p = block.props;
  if ((p.textColor && p.textColor !== 'default') || (p.backgroundColor && p.backgroundColor !== 'default') ||
      (p.textAlignment && p.textAlignment !== 'left') || p.isToggleable) return null;
  if (block.type === 'markdown') return readMarkdownSource(block);
  if (block.content?.some(item => item.type !== 'text' || Object.keys(item.styles).length)) return null;
  const raw = block.content?.map(item => item.type === 'text' ? item.text : '').join('') ?? '';
  // Older paragraphs with soft line breaks/indents need their original renderer.
  if (/[\r\n]/.test(raw) || /^[\t ]/.test(raw)) return null;
  const value = raw.replace(/([\\`*_{}\[\]<>#.!()|~+\-=])/g, '\\$1');
  switch (block.type) {
    case 'paragraph': return value;
    case 'heading': return '#'.repeat(Number(p.level) || 1) + ' ' + value;
    case 'bulletListItem': return '- ' + value;
    case 'numberedListItem': return (p.start || 1) + '. ' + value;
    case 'quote': return '> ' + value;
    default: return null;
  }
}

export function writingAreas(doc: CourseDocument): EditorArea[] {
  const result: EditorArea[] = [];
  let parts: TextPart[] = [], start = 0, boundary = '';
  function flush(end: number) {
    result.push({ type: 'text', key: 'text:' + boundary, start, end, parts,
      source: parts.map(part => part.source).join(paragraphBreak) });
    parts = [];
  }
  doc.blocks.forEach((block, i) => {
    if (block.id === doc.titleBlockId) {
      if (parts.length || start > 0) flush(i);
      if (block.children?.length) result.push({ type: 'object', key: 'object:' + block.id, index: i, block });
    } else {
      const source = textSource(block);
      if (source !== null) { parts.push({ block, source }); return; }
      flush(i);
      result.push({ type: 'object', key: 'object:' + block.id, index: i, block });
    }
    start = i + 1;
    boundary = block.id;
  });
  flush(doc.blocks.length);
  return result;
}

function replace(doc: CourseDocument, area: WritingArea, blocks: CourseBlock[]): CourseDocument {
  return { ...doc, blocks: [...doc.blocks.slice(0, area.start), ...blocks, ...doc.blocks.slice(area.end)] };
}

export function editWritingArea(doc: CourseDocument, area: WritingArea, value: string): CourseDocument {
  if (area.source === value) return doc;
  const head: CourseBlock[] = [], tail: CourseBlock[] = [];
  let first = 0, last = area.parts.length;
  let source = value;
  while (first < last && area.parts[first].block.type !== 'markdown' &&
    source.startsWith(area.parts[first].source + paragraphBreak)) {
    const part = area.parts[first++];
    source = source.slice(part.source.length + paragraphBreak.length);
    head.push(part.block);
  }
  while (last > first && area.parts[last - 1].block.type !== 'markdown' &&
    source.endsWith(paragraphBreak + area.parts[last - 1].source)) {
    const part = area.parts[--last];
    source = source.slice(0, -part.source.length - paragraphBreak.length);
    tail.unshift(part.block);
  }
  // Keep an empty Markdown node when a user clears an area. It records the
  // paragraph break if adjacent existing paragraphs are kept untouched.
  const id = first < last ? area.parts[first].block.id : crypto.randomUUID();
  const body = [createMarkdownBlock(id, source)];
  return replace(doc, area, [...head, ...body, ...tail]);
}

// Replacing text is explicitly opt-in and allowed only within one raw
// Markdown region. Legacy structure that happens to resemble text is retained.
export function replaceableSelection(area: WritingArea, start: number, end: number): string | undefined {
  if (start < 0 || end <= start || end > area.source.length) return undefined;
  let from = 0;
  for (const part of area.parts) {
    const to = from + part.source.length;
    if (part.block.type === 'markdown' && start >= from && end <= to) return area.source.slice(start, end);
    from = to + paragraphBreak.length;
  }
  return undefined;
}

export function insertWritingObject(doc: CourseDocument, area: WritingArea, caret: number, object: CourseBlock, replaceThrough?: number): CourseDocument {
  const offset = Math.max(0, Math.min(caret, area.source.length));
  const boundary = replaceThrough !== undefined && replaceableSelection(area, offset, replaceThrough) !== undefined ? replaceThrough : offset;
  const before: CourseBlock[] = [], after: CourseBlock[] = [];
  let start = 0;
  for (const part of area.parts) {
    const end = start + part.source.length;
    if (offset >= end) before.push(part.block);
    else if (boundary <= start) after.push(part.block);
    else {
      const left = part.source.slice(0, Math.max(0, offset - start));
      const right = part.source.slice(boundary - start);
      if (left) before.push(createMarkdownBlock(part.block.id, left));
      if (right) after.push(createMarkdownBlock(left ? crypto.randomUUID() : part.block.id, right));
    }
    start = end + paragraphBreak.length;
  }
  return replace(doc, area, [...before, object, ...after]);
}

export type WritingDrop = { index: number; offset: number };

// Source offsets only between complete top-level Markdown constructs. A nested
// list, code fence or table moves as a unit. Reference definitions stay with
// their uses. If the lexer normalizes its input, preserve the whole old block.
export function writingDropOffsets(block: CourseBlock): number[] {
  if (block.type !== 'markdown' || textSource(block) === null) return [];
  const source = readMarkdownSource(block);
  try {
    const tokens = Lexer.lex(source);
    if (Object.keys(tokens.links).length || tokens.map(token => token.raw).join('') !== source) return [];
    const offsets: number[] = [];
    let offset = 0, hasContent = false;
    for (const token of tokens) {
      if (token.type !== 'space' && token.raw.length) {
        if (hasContent) offsets.push(offset);
        hasContent = true;
      }
      offset += token.raw.length;
    }
    return offsets;
  } catch { return []; }
}

function containsBoundary(block: CourseBlock, titleId: CourseDocument['titleBlockId']): boolean {
  return block.id === titleId || block.type === 'protected' || !!block.children?.some(child => containsBoundary(child, titleId));
}

export function standaloneWritingLink(block: CourseBlock) {
  const inline = block.content?.[0];
  if (block.type === 'paragraph' && !block.children?.length && block.content?.length === 1 && inline?.type === 'link') return inline;
}

export function canDropWritingObject(doc: CourseDocument, id: string, at: WritingDrop): boolean {
  const from = doc.blocks.findIndex(block => block.id === id);
  const source = doc.blocks[from];
  if (!source || source.children?.length || source.id === doc.titleBlockId) return false;
  if (source.type !== 'image' && source.type !== 'courseRecord' && !standaloneWritingLink(source)) return false;
  if (!Number.isInteger(at.index) || at.index < 0 || at.index > doc.blocks.length || !Number.isInteger(at.offset) || at.offset < 0) return false;
  if (at.offset && (!doc.blocks[at.index] || !writingDropOffsets(doc.blocks[at.index]).includes(at.offset))) return false;
  if (at.index === from || at.index === from + 1 && !at.offset) return false;
  const crossed = at.index <= from ? doc.blocks.slice(at.index, from) : doc.blocks.slice(from + 1, at.index + (at.offset ? 1 : 0));
  return !crossed.some(block => containsBoundary(block, doc.titleBlockId));
}

export function dropWritingObject(doc: CourseDocument, id: string, at: WritingDrop): CourseDocument {
  if (!canDropWritingObject(doc, id, at)) return doc;
  const from = doc.blocks.findIndex(block => block.id === id);
  const blocks = [...doc.blocks];
  const [object] = blocks.splice(from, 1);
  const index = at.index - Number(from < at.index);
  if (at.offset) {
    const target = blocks[index];
    const source = readMarkdownSource(target);
    const piece = (id: string, text: string) => ({ ...target, ...createMarkdownBlock(id, text), props: target.props });
    blocks.splice(index, 1, piece(target.id, source.slice(0, at.offset)), object, piece(crypto.randomUUID(), source.slice(at.offset)));
  } else {
    blocks.splice(index, 0, object);
  }
  return { ...doc, blocks };
}

// One press moves to the next drop position, including positions between
// paragraphs of a continuous writing area.
export function adjacentWritingDrop(doc: CourseDocument, id: string, direction: -1 | 1): WritingDrop | undefined {
  const from = doc.blocks.findIndex(block => block.id === id);
  const index = from + direction;
  const neighbor = doc.blocks[index];
  if (!neighbor || containsBoundary(neighbor, doc.titleBlockId)) return;
  const offsets = writingDropOffsets(neighbor);
  const offset = direction === 1 ? offsets[0] : offsets.at(-1);
  const at = offset === undefined ? { index: direction === 1 ? index + 1 : index, offset: 0 } : { index, offset };
  if (canDropWritingObject(doc, id, at)) return at;
}

export function moveWritingObject(doc: CourseDocument, id: string, direction: -1 | 1): CourseDocument {
  const at = adjacentWritingDrop(doc, id, direction);
  return at ? dropWritingObject(doc, id, at) : doc;
}

export function removeWritingObject(doc: CourseDocument, id: string): CourseDocument {
  const index = doc.blocks.findIndex(block => block.id === id);
  if (index < 0 || doc.blocks[index].type === 'protected' || id === doc.titleBlockId) return doc;
  const blocks = [...doc.blocks];
  blocks.splice(index, 1);
  const a = blocks[index - 1], b = blocks[index];
  if (a?.type === 'markdown' && b?.type === 'markdown' && !a.children?.length && !b.children?.length &&
      !Object.keys(a.props).length && !Object.keys(b.props).length) {
    blocks.splice(index - 1, 2, createMarkdownBlock(a.id, readMarkdownSource(a) + readMarkdownSource(b)));
  }
  return { ...doc, blocks };
}
