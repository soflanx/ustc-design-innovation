import { collectCourseMarkdownReferences } from './course-markdown-references';

/** Serializable teaching document shared by the Markdown and block editors. */
export type CourseText = { type: 'text'; text: string; styles: Record<string, boolean | string> };
export type CourseInline = CourseText | { type: 'link'; href: string; content: CourseText[] };
export type CourseBlock = {
  id: string;
  type: 'markdown' | 'paragraph' | 'heading' | 'bulletListItem' | 'numberedListItem' | 'checkListItem' | 'quote' | 'callout' | 'toggle' | 'image' | 'courseData' | 'courseRecord' | 'protected';
  props: Record<string, string | number | boolean>;
  content?: CourseInline[];
  children?: CourseBlock[];
};
export const courseHomeLessonSlots = ['previous', 'next'] as const;
export const courseHomeLessonMaxLength = 300;
export type CourseHomeLessonSlot = typeof courseHomeLessonSlots[number];
export type CourseHomeLessonNote = { text: string; pageId?: string };
export type CourseHomeLessonNotes = Partial<Record<CourseHomeLessonSlot, CourseHomeLessonNote>>;
export type CourseDocument = {
  version: 1;
  blocks: CourseBlock[];
  /** Absent for legacy external titles; null records an intentionally removed title. */
  titleBlockId?: string | null;
  lessonNotes?: CourseHomeLessonNotes;
};
export type CourseReferences = { assignmentIds: string[]; resourceIds: string[]; groupIds: string[]; pageIds: string[] };

export class CourseDocumentError extends Error {}
function fail(message = '页面内容格式不正确，请检查后重试。'): never { throw new CourseDocumentError(message); }
const colors = new Set(['default', 'gray', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']);
const blockTypes = new Set(['markdown', 'paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'quote', 'callout', 'toggle', 'image', 'courseData', 'courseRecord', 'protected']);

export function createMarkdownBlock(id: string, source: string): CourseBlock {
  return { id, type: 'markdown', props: {}, content: [{ type: 'text', text: source, styles: {} }], children: [] };
}

export function readMarkdownSource(block: CourseBlock): string {
  return (block.content ?? []).map(inline => inline.type === 'text' ? inline.text : '').join('');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('页面中包含暂不支持的格式。');
}
function string(value: unknown, max = 12000): string {
  if (typeof value !== 'string' || value.length > max || /\u0000/.test(value)) fail('页面文字过长或格式无效。');
  return value;
}

function parseLessonNotes(value: unknown): CourseHomeLessonNotes | undefined {
  if (value === undefined) return;
  const fields = object(value);
  exactKeys(fields, courseHomeLessonSlots);
  const notes: CourseHomeLessonNotes = {};
  for (const slot of courseHomeLessonSlots) {
    if (fields[slot] === undefined) continue;
    const note = object(fields[slot]);
    exactKeys(note, ['text', 'pageId']);
    const text = string(note.text, courseHomeLessonMaxLength).trim();
    const pageId = note.pageId === undefined ? undefined : string(note.pageId, 200);
    if (pageId === '') fail('请选择有效的课次。');
    if (text || pageId) notes[slot] = pageId ? { text, pageId } : { text };
  }
  return notes.previous || notes.next ? notes : undefined;
}

/** Same-origin paths and explicit HTTP(S) links; never data:, javascript: or protocol-relative URLs. */
export function isSafeCourseUrl(value: string, allowEmpty = false): boolean {
  if (!value) return allowEmpty;
  if (value.length > 2048 || /[\s\u0000-\u001f\u007f\\]/u.test(value)) return false;
  if (value.startsWith('/') && !value.startsWith('//')) return !/^\/(?:%2f|%5c)/i.test(value);
  if (/^#[A-Za-z0-9_-]+$/.test(value)) return true;
  try { const url = new URL(value); return /^https?:\/\//i.test(value) && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}

export function parseCourseDocument(value: unknown, { home = false } = {}): CourseDocument {
  // A home may already be at the former limits before its two legacy notes
  // become ordinary paragraphs and lesson references.
  const maxBytes = home ? 254000 : 250000;
  const maxBlocks = home ? 254 : 250;
  const maxText = home ? 62000 : 60000;
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return fail(); }
  if (!serialized || new TextEncoder().encode(serialized).length > maxBytes) fail('页面内容请控制在 ' + maxBytes / 1000 + ' KB 以内。');
  const root = object(value);
  exactKeys(root, ['version', 'blocks', 'titleBlockId', 'lessonNotes']);
  if (root.version !== 1 || !Array.isArray(root.blocks)) fail('页面版本不受支持。');
  const titleBlockId = root.titleBlockId === undefined || root.titleBlockId === null ? root.titleBlockId : string(root.titleBlockId, 128);
  const lessonNotes = parseLessonNotes(root.lessonNotes);
  let blockCount = 0;
  let totalBlockCount = 0;
  let textLength = 0;
  const seen = new Set<string>();
  function readText(value: unknown, max = 12000): CourseText {
    const item = object(value);
    exactKeys(item, ['type', 'text', 'styles']);
    if (item.type !== 'text') fail();
    const text = string(item.text, max);
    textLength += text.length;
    if (textLength > maxText) fail('页面正文请控制在 ' + maxText + ' 字以内。');
    const styles = object(item.styles ?? {});
    exactKeys(styles, ['bold', 'italic', 'underline', 'strike', 'code', 'textColor', 'backgroundColor']);
    for (const [key, val] of Object.entries(styles)) {
      if (['textColor', 'backgroundColor'].includes(key) ? typeof val !== 'string' || !colors.has(val) : typeof val !== 'boolean') fail('页面文字样式不受支持。');
    }
    return { type: 'text', text, styles: { ...styles } as CourseText['styles'] };
  }
  function readInline(value: unknown): CourseInline {
    const item = object(value);
    if (item.type === 'text') return readText(item);
    exactKeys(item, ['type', 'href', 'content']);
    if (item.type !== 'link' || !Array.isArray(item.content)) fail();
    const href = string(item.href, 2048);
    if (!isSafeCourseUrl(href)) fail('链接只支持 http、https 或站内路径。');
    return { type: 'link', href, content: item.content.map(part => readText(part)) };
  }
  function readBlock(value: unknown, depth: number): CourseBlock {
    if (++totalBlockCount > maxBlocks + 250 + (titleBlockId ? 1 : 0) || depth > 6) fail('页面最多支持 ' + maxBlocks + ' 个内容块和 6 层嵌套。');
    const item = object(value);
    exactKeys(item, ['id', 'type', 'props', 'content', 'children']);
    const id = string(item.id, 200);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || seen.has(id)) fail('内容块标识重复或无效。');
    seen.add(id);
    if (!blockTypes.has(String(item.type))) fail('页面中包含暂不支持的组件。');
    const type = item.type as CourseBlock['type'];
    // Moving the former external page title into the document does not consume
    // one of an existing page's 250 authored-content slots.
    if (type !== 'protected' && id !== titleBlockId && ++blockCount > maxBlocks) fail('页面最多支持 ' + maxBlocks + ' 个内容块。');
    if (type !== 'protected' && id.length > 128) fail('内容块标识过长。');
    if (id.startsWith('__locked_') !== (type === 'protected')) fail('保留内容标识无效。');
    const props = { ...object(item.props ?? {}) };
    const common = ['textColor', 'backgroundColor', 'textAlignment'];
    const extra: Record<CourseBlock['type'], string[]> = {
      markdown: [], paragraph: [], heading: ['level', 'isToggleable'], bulletListItem: [], numberedListItem: ['start'],
      checkListItem: ['checked'], quote: [], callout: ['tone'], toggle: ['title'],
      image: ['url', 'caption', 'name', 'previewWidth', 'showPreview'],
      courseData: ['kind', 'ids', 'layout', 'title', 'grouped'], courseRecord: ['kind', 'recordId', 'display'], protected: [],
    };
    exactKeys(props, type === 'protected' ? [] : [...common, ...extra[type]]);
    for (const [key, val] of Object.entries(props)) {
      if (!['string', 'number', 'boolean'].includes(typeof val)) fail();
      if (['textColor', 'backgroundColor'].includes(key) && !colors.has(String(val))) fail();
      if (key === 'textAlignment' && !['left', 'center', 'right', 'justify'].includes(String(val))) fail();
      if (['checked', 'showPreview', 'isToggleable', 'grouped'].includes(key) && typeof val !== 'boolean') fail();
      if (key === 'level' && (typeof val !== 'number' || ![1, 2, 3].includes(val))) fail();
      if (key === 'start' && (!Number.isInteger(val) || Number(val) < 1 || Number(val) > 10000)) fail();
      if (key === 'previewWidth' && (typeof val !== 'number' || !Number.isFinite(val) || val < 1 || val > 4000)) fail();
      if (key === 'tone' && !['info', 'warning', 'success'].includes(String(val))) fail();
      if (['caption', 'name', 'title'].includes(key)) string(val, 500);
    }
    if (type === 'image') {
      const url = string(props.url ?? '', 2048);
      if (!isSafeCourseUrl(url, true) || url.startsWith('#')) fail('图片只支持 http、https 或站内地址。');
      props.url = url;
    }
    if (type === 'courseData') {
      if (!['assignments', 'resources', 'groups'].includes(String(props.kind)) || !['cards', 'list'].includes(String(props.layout))) fail('教学数据视图格式不正确。');
      const idsString = string(props.ids, 100000);
      let ids: unknown;
      try { ids = JSON.parse(idsString); } catch { return fail('教学数据引用格式不正确。'); }
      if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string' || !id || id.length > 200)) fail('教学数据引用格式不正确。');
      props.ids = JSON.stringify([...new Set(ids)]);
    }
    if (type === 'courseRecord') {
      if (!['assignments', 'resources', 'groups', 'pages'].includes(String(props.kind)) || !['link', 'card'].includes(String(props.display))) fail('教学记录格式不正确。');
      props.recordId = string(props.recordId ?? '', 200);
      if (props.kind === 'pages' && !props.recordId) fail('请选择要关联的课程子页面。');
    }
    if (item.content !== undefined && !Array.isArray(item.content)) fail();
    if (item.children !== undefined && !Array.isArray(item.children)) fail();
    const children = ((item.children ?? []) as unknown[]).map(child => readBlock(child, depth + 1));
    if (type === 'markdown') {
      const parts = ((item.content ?? []) as unknown[]).map(part => readText(part, Infinity));
      if (parts.some(part => Object.keys(part.styles).length)) fail('Markdown 正文请直接使用文本标记。');
      return { id, type, props: props as CourseBlock['props'], content: parts, children };
    }
    const content = ((item.content ?? []) as unknown[]).map(readInline);
    if (['image', 'courseData', 'courseRecord', 'protected'].includes(type) && content.length) fail('图片和教学记录不能包含行内正文。');
    return { id, type, props: props as CourseBlock['props'], ...(!['image', 'courseData', 'courseRecord', 'protected'].includes(type) ? { content } : {}), children };
  }
  const result: CourseDocument = {
    version: 1, blocks: root.blocks.map(block => readBlock(block, 1)),
    ...(titleBlockId !== undefined ? { titleBlockId } : {}),
    ...(lessonNotes ? { lessonNotes } : {}),
  };
  if (titleBlockId !== undefined && titleBlockId !== null && !courseTitleBlock(result)) fail('页面标题引用无效，请重新载入编辑器。');
  return result;
}

/** Find the designated title by identity, including after dragging it into a list or section. */
export function courseTitleBlock(document: CourseDocument): CourseBlock | undefined {
  if (!document.titleBlockId) return undefined;
  const find = (blocks: CourseBlock[]): CourseBlock | undefined => {
    for (const block of blocks) {
      if (block.id === document.titleBlockId) return block.type === 'heading' && block.props.level === 1 ? block : undefined;
      const nested = find(block.children ?? []);
      if (nested) return nested;
    }
  };
  return find(document.blocks);
}

/** Upgrade the old title only for rendering/editing, without writing the database. */
export function ensureCoursePageTitle(document: CourseDocument, title: string): CourseDocument {
  if (document.titleBlockId !== undefined) return document;
  const ids = new Set<string>();
  const visit = (blocks: CourseBlock[]) => blocks.forEach(block => { ids.add(block.id); visit(block.children ?? []); });
  visit(document.blocks);
  let id = 'course-page-title';
  for (let suffix = 1; ids.has(id); suffix++) id = `course-page-title-${suffix}`;
  return {
    ...document, titleBlockId: id,
    blocks: [{ id, type: 'heading', props: { level: 1 }, content: title ? [{ type: 'text', text: title, styles: {} }] : [], children: [] }, ...document.blocks],
  };
}

/** BlockNote emits only blocks. Keep the title identity while allowing deletion and undo. */
export function retainCourseTitleReference(document: CourseDocument, titleBlockId: string | null): CourseDocument {
  const candidate = { ...document, titleBlockId };
  return courseTitleBlock(candidate) ? candidate : { ...document, titleBlockId: null };
}

/** The database title remains a short metadata label, derived from the visible title block. */
export function courseDocumentTitle(document: CourseDocument, fallback = '无标题'): string {
  const text = courseTitleBlock(document)?.content?.map(inline => inline.type === 'text' ? inline.text : inline.content.map(part => part.text).join('')).join('');
  return (text?.replace(/\s+/gu, ' ').trim() || fallback.trim() || '无标题').slice(0, 100);
}

export function collectCourseReferences(document: CourseDocument, { strictMarkdown = false } = {}): CourseReferences {
  const byKind = { assignments: new Set<string>(), resources: new Set<string>(), groups: new Set<string>(), pages: new Set<string>() };
  const visit = (blocks: CourseBlock[]) => blocks.forEach(block => {
    if (block.type === 'courseData' || block.type === 'courseRecord') {
      const ids = block.type === 'courseData' ? JSON.parse(String(block.props.ids)) as string[] : block.props.recordId ? [String(block.props.recordId)] : [];
      const target = byKind[block.props.kind as keyof typeof byKind];
      ids.forEach(id => target.add(id));
    }
    if (block.type === 'markdown') {
      for (const { kind, id } of collectCourseMarkdownReferences(readMarkdownSource(block), { strict: strictMarkdown })) byKind[kind].add(id);
    }
    visit(block.children ?? []);
  });
  visit(document.blocks);
  for (const slot of courseHomeLessonSlots) {
    const pageId = document.lessonNotes?.[slot]?.pageId;
    if (pageId) byKind.pages.add(pageId);
  }
  return { assignmentIds: [...byKind.assignments], resourceIds: [...byKind.resources], groupIds: [...byKind.groups], pageIds: [...byKind.pages] };
}

/** Turn older prompts into normal, editable content before projecting references. */
export function expandCourseHomeLessonNotes(document: CourseDocument): CourseDocument {
  const { lessonNotes, ...body } = document;
  if (!lessonNotes) return document;
  const ids = new Set<string>();
  function collect(blocks: CourseBlock[]) {
    for (const block of blocks) {
      ids.add(block.id);
      collect(block.children ?? []);
    }
  }
  collect(body.blocks);
  function uniqueId(base: string) {
    let id = base;
    for (let suffix = 1; ids.has(id); suffix++) id = base + '-' + suffix;
    ids.add(id);
    return id;
  }
  const added: CourseBlock[] = [];
  for (const slot of courseHomeLessonSlots) {
    const note = lessonNotes[slot];
    if (!note) continue;
    if (note.text.trim()) {
      // Legacy prompts were plain text. Escaping preserves literal punctuation
      // while opening the text in the usual Markdown writing area.
      const source = note.text.replace(/[\\*_{}\[\]<>#.!()|~+\-=:&\x60]/g, '\\$&').replace(/\r\n?|\n/g, '  \n');
      added.push(createMarkdownBlock(uniqueId('legacy-home-' + slot + '-text'), source));
    }
    if (note.pageId) {
      added.push({
        id: uniqueId('legacy-home-' + slot + '-page'), type: 'courseRecord',
        props: { kind: 'pages', recordId: note.pageId, display: 'link' }, children: [],
      });
    }
  }
  const afterTitle = body.blocks.findIndex(block => block.id === body.titleBlockId) + 1;
  return { ...body, blocks: [...body.blocks.slice(0, afterTitle), ...added, ...body.blocks.slice(afterTitle)] };
}

/**
 * Upgrade old presentation wrappers in memory, without rewriting stored data.
 * Stable IDs never include record IDs, since an opaque hidden-record placeholder
 * must not reveal the referenced resource. Large old views stay intact instead
 * of making an existing document exceed its save limits.
 */
export function normalizeCourseDocument(document: CourseDocument, options: { preserveViewIds?: ReadonlySet<string> } = {}): CourseDocument {
  const result = structuredClone(document);
  const existingIds = new Set<string>();
  let authoredCount = 0;
  const inventory = (blocks: CourseBlock[]) => blocks.forEach(block => {
    block.children ??= [];
    existingIds.add(block.id);
    if (block.type !== 'protected') authoredCount++;
    inventory(block.children ?? []);
  });
  inventory(result.blocks);
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  let usedBytes = bytes(result);
  const nextId = (source: string, suffix: string) => {
    const base = `${source.slice(0, 100)}-${suffix}`;
    let candidate = base;
    for (let index = 1; existingIds.has(candidate); index++) candidate = `${base}-${index}`;
    existingIds.add(candidate);
    return candidate;
  };
  const count = (blocks: CourseBlock[]): number => blocks.reduce((sum, block) => sum + (block.type === 'protected' ? 0 : 1) + count(block.children ?? []), 0);
  const adopt = (block: CourseBlock, replacement: CourseBlock[]): CourseBlock[] | null => {
    const addedCount = count(replacement) - count([block]);
    const addedBytes = bytes(replacement) - bytes([block]);
    if (authoredCount + addedCount > 250 || usedBytes + addedBytes > 250000) return null;
    authoredCount += addedCount;
    usedBytes += addedBytes;
    return replacement;
  };
  const normalize = (blocks: CourseBlock[]): CourseBlock[] => blocks.flatMap(block => {
    block.children = normalize(block.children ?? []);
    // Only the known legacy paragraph uses hard newlines as independent paragraphs.
    // User-authored Shift+Enter soft breaks in other blocks remain untouched.
    if (block.id === 'legacy-body' && block.type === 'paragraph' && block.content?.every(inline => inline.type === 'text' && Object.keys(inline.styles).length === 0)) {
      const text = block.content.map(inline => (inline as CourseText).text).join('');
      const lines = text.split(/\r\n|\r|\n/);
      if (lines.length > 1) {
        const available = Math.max(1, 251 - authoredCount);
        const chunkSize = Math.ceil(lines.length / available);
        const paragraphs: CourseBlock[] = [];
        for (let index = 0; index < lines.length; index += chunkSize) paragraphs.push({
          ...block, id: nextId(block.id, `paragraph-${index}`),
          content: [{ type: 'text', text: lines.slice(index, index + chunkSize).join('\n'), styles: {} }], children: [],
        });
        paragraphs[paragraphs.length - 1].children = block.children;
        return adopt(block, paragraphs) ?? [block];
      }
    }
    if (block.type !== 'courseData' || block.props.grouped === true) return [block];
    if (options.preserveViewIds?.has(block.id)) return adopt(block, [{ ...block, props: { ...block.props, grouped: true } }]) ?? [block];
    const common = Object.fromEntries(['textColor', 'backgroundColor', 'textAlignment'].filter(key => block.props[key] !== undefined).map(key => [key, block.props[key]]));
    const title = String(block.props.title ?? '');
    const ids = JSON.parse(String(block.props.ids)) as string[];
    const replacement: CourseBlock[] = [];
    if (title) replacement.push({ id: block.id, type: 'heading', props: { ...common, level: 2 }, content: [{ type: 'text', text: title, styles: {} }], children: [] });
    (ids.length ? ids : ['']).forEach((recordId, index) => replacement.push({
      id: !title && index === 0 ? block.id : nextId(block.id, `record-${index}`), type: 'courseRecord',
      props: { ...common, kind: block.props.kind, recordId, display: block.props.layout === 'cards' ? 'card' : 'link' }, children: [],
    }));
    replacement.push(...(block.children ?? []));
    const expanded = adopt(block, replacement);
    if (expanded) return expanded;
    // Near the byte ceiling even a flag may not fit; in that exceptional case
    // retaining the original wrapper is safer than a truncated upgrade.
    return adopt(block, [{ ...block, props: { ...block.props, grouped: true } }]) ?? [block];
  });
  result.blocks = normalize(result.blocks);
  return result;
}

export function legacyCourseDocument(focus: { body: string; assignmentIds: string[]; resourceIds: string[] } | null, options: { normalize?: boolean } = {}): CourseDocument {
  const blocks: CourseBlock[] = [];
  if (focus?.body) blocks.push({ id: 'legacy-body', type: 'paragraph', props: {}, content: [{ type: 'text', text: focus.body, styles: {} }], children: [] });
  if (focus?.assignmentIds.length) blocks.push({ id: 'legacy-assignments', type: 'courseData', props: { kind: 'assignments', ids: JSON.stringify(focus.assignmentIds), layout: 'cards', title: '本次任务' }, children: [] });
  if (focus?.resourceIds.length) blocks.push({ id: 'legacy-resources', type: 'courseData', props: { kind: 'resources', ids: JSON.stringify(focus.resourceIds), layout: 'list', title: '本次资料' }, children: [] });
  return options.normalize === false ? { version: 1, blocks } : normalizeCourseDocument({ version: 1, blocks });
}
