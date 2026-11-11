import { Lexer } from 'marked';
import { courseTitleBlock, createMarkdownBlock, isSafeCourseUrl, type CourseBlock, type CourseDocument } from './course-document';
import type { CourseDocumentCatalog } from './course-document-view';
import { writingAreas, standaloneWritingLink } from './course-markdown-edit';
import { courseMarkdownReferenceLink, parseCourseMarkdownReference } from './course-markdown-references';

const referenceKinds = ['pages', 'assignments', 'resources', 'groups'] as const;
type ReferenceKind = typeof referenceKinds[number];
const legacyLine = /^\[[^\]\n]*\]\(course-keep:([A-Za-z0-9_-]+)\)[ \t]*$/;
const legacyLink = /\[[^\]\n]*\]\(course-keep:[A-Za-z0-9_-]+\)/g;

type RetainedBlock = { block: CourseBlock; required: boolean };
export type CourseMarkdownSource = {
  source: string;
  original: CourseDocument;
  retained: ReadonlyMap<string, RetainedBlock>;
  legacyReferences: ReadonlyMap<string, readonly CourseBlock[]>;
};

const lineBreaks = (source: string) => source.replace(/\r\n?/g, '\n');
const literalLabel = (label: string) => lineBreaks(label).replace(/\n/g, ' ').replace(/[\\\[\]*_`~&<>]/g, '\\$&');
const destination = (href: string) => '<' + href.replace(/</g, '%3C').replace(/>/g, '%3E') + '>';

export function courseMarkdownLink(label: string, href: string) {
  return `[${literalLabel(label)}](${destination(href)})`;
}

export function courseMarkdownImage(url: string, caption: string) {
  const text = lineBreaks(caption).replace(/\n/g, ' ').trim();
  const title = text ? ` "${text.replace(/[\\"&]/g, '\\$&')}"` : '';
  return `![${literalLabel(text)}](${destination(url)}${title})`;
}

function isReferenceKind(value: unknown): value is ReferenceKind {
  return referenceKinds.some(kind => kind === value);
}

function editableObjectSource(block: CourseBlock, catalog?: CourseDocumentCatalog) {
  if (block.children?.length) return;
  if (block.type === 'courseRecord') {
    const { kind, recordId, display: _display, ...format } = block.props;
    if (Object.keys(format).length || !isReferenceKind(kind) || typeof recordId !== 'string' || !recordId) return;
    if (!parseCourseMarkdownReference(`course:${kind}/${encodeURIComponent(recordId)}`)) return;
    const record = catalog?.[kind]?.find(item => item.id === recordId);
    return courseMarkdownReferenceLink(kind, recordId, record?.title ?? ({ pages: '课次', assignments: '作业', resources: '资料', groups: '小组' }[kind]));
  }
  const link = standaloneWritingLink(block);
  if (link && !Object.keys(block.props).length && link.content.every(span => !Object.keys(span.styles).length)
    && isSafeCourseUrl(link.href)) return courseMarkdownLink(link.content.map(span => span.text).join(''), link.href);
}

function protectedBlock(block: CourseBlock, titleId: CourseDocument['titleBlockId']): boolean {
  return block.type === 'protected' || block.id === titleId || !!block.children?.some(child => protectedBlock(child, titleId));
}

function topLevelObjectLines(source: string, legacyReferences: CourseMarkdownSource['legacyReferences']) {
  const lines = new Map<number, string>();
  if (!legacyReferences.size && !source.includes('course-keep:')) return lines;
  try {
    let offset = 0;
    for (const token of Lexer.lex(source, { gfm: true })) {
      // The lexer can omit a reference definition from the rendered tokens.
      // Recover each exact source range in order rather than altering its text.
      const index = source.indexOf(token.raw, offset);
      if (index < 0) return lines;
      offset = index + token.raw.length;
      if (token.type !== 'paragraph' || (index && source[index - 1] !== '\n')) continue;
      const line = token.raw.replace(/\n+$/, '');
      if (legacyLine.test(line) || legacyReferences.has(line)) lines.set(index, line);
    }
  } catch { /* Keep original protected blocks even if the current source is incomplete. */ }
  return lines;
}

/** Keep the text in a single field. Only old structures with no faithful source use local markers. */
export function projectCourseMarkdownSource(document: CourseDocument, catalog?: CourseDocumentCatalog): CourseMarkdownSource {
  const editable = new Map(writingAreas(document).flatMap(area => area.type === 'text'
    ? area.parts.map(({ block, source }) => [block.id, source] as const) : []));
  const body = document.blocks.flatMap((block, index) => index === 0 && block.id === document.titleBlockId ? [] : [{
    block, source: editable.get(block.id) ?? editableObjectSource(block, catalog),
  }]);
  const retained = new Map<string, RetainedBlock>();
  const legacyReferences = new Map<string, CourseBlock[]>();
  const pieces: string[] = [];
  for (const [index, { block, source }] of body.entries()) {
    const mergesSources = body[index - 1]?.source !== undefined || body[index + 1]?.source !== undefined;
    if (source !== undefined && !(mergesSources && block.type === 'markdown' && keepsMarkdownBoundary(source))) {
      pieces.push(lineBreaks(source));
      if (block.type === 'courseRecord') {
        const matches = legacyReferences.get(source) ?? [];
        matches.push(block);
        legacyReferences.set(source, matches);
      }
      continue;
    }
    const key = `block-${block.id}`;
    const label = block.type === 'protected' ? '保留受限资料引用' : block.type === 'image' ? '保留原图片'
      : block.type === 'markdown' ? '保留原 Markdown 段落' : '保留原内容块';
    retained.set(key, { block, required: protectedBlock(block, document.titleBlockId) });
    pieces.push(`[${label}](course-keep:${key})`);
  }
  return { source: pieces.join('\n\n'), original: document, retained, legacyReferences };
}

/** Restore legacy blocks by identity, including the current value of a separately edited title. */
export function applyCourseMarkdownSource(document: CourseDocument, projection: CourseMarkdownSource, source: string): CourseDocument {
  const { original, retained } = projection;
  const title = courseTitleBlock(document);
  function updateTitle(block: CourseBlock): CourseBlock {
    if (title && block.id === title.id) return title;
    const children = block.children?.map(updateTitle);
    return children?.some((child, index) => child !== block.children?.[index]) ? { ...block, children } : block;
  }
  if (source === projection.source) {
    if (document === original) return document;
    const blocks = original.blocks.map(updateTitle);
    if (title && title.id !== original.titleBlockId) blocks.unshift(title);
    return { ...document, blocks };
  }

  const blocks: CourseBlock[] = [];
  if (title && (original.blocks[0]?.id === original.titleBlockId || title.id !== original.titleBlockId)) blocks.push(title);
  const ids = new Set<string>();
  function reserve(block: CourseBlock) {
    ids.add(block.id);
    block.children?.forEach(reserve);
  }
  original.blocks.forEach(reserve);
  if (title) reserve(title);
  let suffix = 0;
  const seen = new Set<string>();
  let lines: string[] = [], followsMarker = false;
  function flush(precedesMarker: boolean) {
    const first = Number(followsMarker && lines[0] === '');
    const end = lines.length - Number(precedesMarker && lines.at(-1) === '');
    const markdown = lines.slice(first, end).join('\n');
    lines = [];
    if (!markdown) return;
    let id = 'markdown-source';
    while (ids.has(id)) id = `markdown-source-${++suffix}`;
    ids.add(id);
    blocks.push(createMarkdownBlock(id, markdown));
  }
  const normalized = lineBreaks(source);
  // The old record IDs and link labels did not count toward the text budget.
  // Keep original standalone references in their prior representation near
  // the smaller page limit. The editor still presents a continuous source.
  const legacyReferences = new Map<string, CourseBlock[]>();
  if (normalized.length > 60000) {
    for (const [line, originals] of projection.legacyReferences) legacyReferences.set(line, [...originals]);
  }
  const markers = topLevelObjectLines(normalized, legacyReferences);
  let position = 0;
  for (const line of normalized.split('\n')) {
    const marker = markers.get(position);
    position += line.length + 1;
    const key = marker && legacyLine.exec(marker)?.[1];
    const restored = key ? retained.get(key)?.block : marker ? legacyReferences.get(marker)?.shift() : undefined;
    if (key && (!restored || seen.has(key))) continue;
    if (!restored) { lines.push(line.replace(legacyLink, '')); continue; }
    flush(true);
    blocks.push(updateTitle(restored));
    if (key) seen.add(key);
    followsMarker = true;
  }
  flush(false);
  for (const [key, entry] of retained) {
    if (!seen.has(key) && (entry.required || source.includes(`course-keep:${key})`))) blocks.push(updateTitle(entry.block));
  }
  return { ...document, blocks };
}

function unclosedFence(raw: string): boolean {
  const [first, ...rest] = raw.split('\n');
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(first)?.[1];
  if (!fence) return false;
  const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \t]*$`);
  return !rest.some(line => closing.test(line));
}

function keepsMarkdownBoundary(source: string): boolean {
  try {
    const tokens = Lexer.lex(lineBreaks(source), { gfm: true });
    return Object.keys(tokens.links).length > 0 || tokens.some(token => token.type === 'html' || (token.type === 'code' && unclosedFence(token.raw)));
  } catch { return true; }
}

function insertionOffset(source: string, caret: number): number {
  try {
    const tokens = Lexer.lex(source, { gfm: true });
    if (tokens.map(token => token.raw).join('') !== source) return source.length;
    let start = 0;
    for (const token of tokens) {
      const end = start + token.raw.length;
      if (caret === start) return start;
      if (caret <= end) return token.type === 'code' && unclosedFence(token.raw) ? start : end;
      start = end;
    }
  } catch { /* Keep the typed source even when it cannot be parsed yet. */ }
  return source.length;
}

/** Insert a standalone object without cutting a list, link, table or code block in half. */
export function insertCourseMarkdownLine(source: string, caret: number, line: string) {
  const offset = insertionOffset(source, Math.max(0, Math.min(caret, source.length)));
  const left = source.slice(0, offset), right = source.slice(offset);
  const before = left ? '\n'.repeat(Math.max(0, 2 - (left.match(/\n*$/)?.[0].length ?? 0))) : '';
  const after = '\n'.repeat(Math.max(0, 2 - (right.match(/^\n*/)?.[0].length ?? 0)));
  const start = left.length + before.length + line.length + 2;
  return { source: left + before + line + after + right, start, end: start };
}
