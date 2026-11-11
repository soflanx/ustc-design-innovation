import { Lexer, walkTokens, type Tokens } from 'marked';
import { collectCourseMarkdownReferences, parseCourseMarkdownReference } from './course-markdown-references';
import { courseMarkdownLink, insertCourseMarkdownLine } from './course-markdown-source';

export type MarkdownSnapshot = { source: string; start: number; end: number };
export type MarkdownCommand = 'heading' | 'bold' | 'italic' | 'strike' | 'bullet' | 'ordered' | 'task'
  | 'quote' | 'inlineCode' | 'codeBlock' | 'table' | 'rule';

type LineCommand = 'heading' | 'bullet' | 'ordered' | 'task' | 'quote';
type Line = { start: number; text: string };
type Edit = { start: number; end: number; text: string };

const linePlaceholders: Record<LineCommand, string> = {
  heading: '标题', bullet: '列表项', ordered: '列表项', task: '待办事项', quote: '引用文字',
};

// These editor-only lines stand for old blocks that must remain at their original positions.
const retainedLine = /^\[[^\]\r\n]*\]\(course-keep:[A-Za-z0-9_-]+\)[ \t]*$/;

function replace(snapshot: MarkdownSnapshot, start: number, end: number, text: string, from = text.length, to = from): MarkdownSnapshot {
  return { source: snapshot.source.slice(0, start) + text + snapshot.source.slice(end), start: start + from, end: start + to };
}

function newline(source: string) {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function selectedLines({ source, start, end }: MarkdownSnapshot): Line[] {
  const first = start ? source.lastIndexOf('\n', start - 1) + 1 : 0;
  const last = end > start && source[end - 1] === '\n' ? end - 1 : end;
  const next = source.indexOf('\n', last);
  let offset = first;
  return source.slice(first, next < 0 ? source.length : next).split('\n').map(raw => {
    const line = { start: offset, text: raw.replace(/\r$/, '') };
    offset += raw.length + 1;
    return line;
  });
}

function editPrefixes(snapshot: MarkdownSnapshot, edits: Edit[]): MarkdownSnapshot {
  if (!edits.length) return snapshot;
  let source = '', cursor = 0;
  for (const edit of edits) {
    source += snapshot.source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  const moved = (offset: number) => {
    let delta = 0;
    for (const edit of edits) {
      if (offset < edit.start) break;
      if (offset <= edit.end) return edit.start + delta + edit.text.length;
      delta += edit.text.length - (edit.end - edit.start);
    }
    return offset + delta;
  };
  return { source: source + snapshot.source.slice(cursor), start: moved(snapshot.start), end: moved(snapshot.end) };
}

function listLine(line: string) {
  const match = /^([ \t]*(?:>[ \t]*)*)([-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(line);
  if (!match) return;
  const task = /^\[[ xX]\](?:[ \t]+|$)/.exec(line.slice(match[0].length));
  const kind = task ? 'task' : /^\d/.test(match[2]) ? 'ordered' : 'bullet';
  return { indent: match[1], marker: match[2], end: match[0].length + (task?.[0].length ?? 0), kind } as const;
}

function prefixFor(command: LineCommand, ordinal = 1) {
  switch (command) {
    case 'heading': return '## ';
    case 'bullet': return '- ';
    case 'ordered': return `${ordinal}. `;
    case 'task': return '- [ ] ';
    case 'quote': return '> ';
  }
}

function formatLines(snapshot: MarkdownSnapshot, command: LineCommand) {
  const lines = selectedLines(snapshot).filter(line => !retainedLine.test(line.text));
  if (!lines.length) return snapshot;
  if (snapshot.start === snapshot.end && !lines[0].text.trim()) {
    const offset = lines[0].start + lines[0].text.length;
    const prefix = prefixFor(command), placeholder = linePlaceholders[command];
    return replace(snapshot, offset, offset, prefix + placeholder, prefix.length, prefix.length + placeholder.length);
  }
  const entries = lines.filter(line => line.text.trim()).map(line => {
    const indent = /^[ \t]*/.exec(line.text)![0];
    if (command === 'heading' || command === 'quote') {
      const pattern = command === 'heading' ? /^#{1,6}(?:[ \t]+|$)/ : /^>[ \t]?/;
      const existing = pattern.exec(line.text.slice(indent.length))?.[0];
      return { start: line.start + indent.length, length: existing?.length ?? 0, matches: !!existing };
    }
    const existing = listLine(line.text);
    const start = existing?.indent.length ?? indent.length;
    return { start: line.start + start, length: existing ? existing.end - start : 0, matches: existing?.kind === command,
      ordinal: existing?.kind === 'ordered' ? Number(existing.marker.slice(0, -1)) : undefined };
  });
  const remove = entries.every(entry => entry.matches);
  let ordinal = 0;
  return editPrefixes(snapshot, entries.flatMap(entry => {
    ordinal = entry.ordinal ?? ordinal + 1;
    if (!remove && entry.matches) return [];
    return [{ start: entry.start, end: entry.start + entry.length, text: remove ? '' : prefixFor(command, ordinal) }];
  }));
}

function exactMarker(source: string, offset: number, marker: string, escapes: boolean) {
  if (offset < 0 || !source.startsWith(marker, offset) || source[offset - 1] === marker[0] || source[offset + marker.length] === marker[0]) return false;
  if (!escapes) return true;
  let slashes = 0;
  while (source[offset - slashes - 1] === '\\') slashes++;
  return slashes % 2 === 0;
}

function unwrap(snapshot: MarkdownSnapshot, marker: string, padding = '', code = false) {
  const { source, start, end } = snapshot;
  const width = marker.length + padding.length;
  const ranges = [[start - width, end + width], [start, end]];
  for (const [from, to] of ranges) {
    if (to > source.length || to - from <= 2 * width) continue;
    if (!exactMarker(source, from, marker, true) || !exactMarker(source, to - marker.length, marker, !code)) continue;
    if (!source.startsWith(marker + padding, from) || source.slice(to - width, to) !== padding + marker) continue;
    const raw = source.slice(from, to);
    const expected = code ? 'codespan' : marker[0] === '~' ? 'del' : marker.length === 2 ? 'strong' : 'em';
    try {
      const tokens = Lexer.lexInline(raw, { gfm: true });
      if (tokens.length !== 1 || tokens[0].type !== expected || tokens[0].raw !== raw) continue;
    } catch { continue; }
    const content = source.slice(from + width, to - width);
    return replace(snapshot, from, to, content, 0, content.length);
  }
}

const longestBackticks = (text: string) => Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));

function formatInline(snapshot: MarkdownSnapshot, command: 'bold' | 'italic' | 'strike' | 'inlineCode') {
  const { source, start, end } = snapshot;
  const selected = source.slice(start, end);
  if (selected && !selected.trim() && command !== 'inlineCode') return snapshot;
  if (command === 'inlineCode') {
    const possible = [source.slice(0, start).match(/`+ ?$/)?.[0], selected.match(/^`+/)?.[0]];
    for (const candidate of possible) {
      if (!candidate) continue;
      const marker = candidate.trim();
      const toggled = unwrap(snapshot, marker, ' ', true) ?? unwrap(snapshot, marker, '', true);
      if (toggled) return toggled;
    }
    const text = selected || '代码';
    const marker = '`'.repeat(longestBackticks(text) + 1);
    const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && !!text.trim()) ? ' ' : '';
    return replace(snapshot, start, end, marker + pad + text + pad + marker, marker.length + pad.length, marker.length + pad.length + text.length);
  }
  const markers = command === 'bold' ? ['**', '__'] : command === 'italic' ? ['*', '_'] : ['~~'];
  for (const marker of markers) {
    const toggled = unwrap(snapshot, marker);
    if (toggled) return toggled;
  }
  const text = selected || '文字';
  // Markdown emphasis markers must touch non-whitespace to render.
  const leading = text.trim() ? /^\s*/u.exec(text)![0].length : 0;
  const trailing = text.trim() ? /\s*$/u.exec(text)![0].length : 0;
  const body = text.slice(leading, text.length - trailing);
  const marker = markers.find(marker => !body.startsWith(marker[0]) && !body.endsWith(marker[0])) ?? markers[0];
  if (command === 'strike' && (body.startsWith('~~') || body.endsWith('~~'))) return snapshot;
  return replace(snapshot, start + leading, end - trailing, marker + body + marker, marker.length, marker.length + body.length);
}

const countBreaks = (text: string) => text.match(/\n/g)?.length ?? 0;

function addBlock(snapshot: MarkdownSnapshot, start: number, end: number, block: string, from: number, to: number) {
  const left = snapshot.source.slice(0, start), right = snapshot.source.slice(end);
  const eol = newline(snapshot.source);
  const trailing = countBreaks(left.match(/(?:\r?\n){0,2}$/)?.[0] ?? '');
  const leading = countBreaks(right.match(/^(?:\r?\n){0,2}/)?.[0] ?? '');
  const before = left ? eol.repeat(2 - trailing) : '';
  const after = eol.repeat(2 - leading);
  return replace(snapshot, start, end, before + block + after, before.length + from, before.length + to);
}

export function applyMarkdownCommand(snapshot: MarkdownSnapshot, command: MarkdownCommand): MarkdownSnapshot {
  if (command === 'heading' || command === 'bullet' || command === 'ordered' || command === 'task' || command === 'quote') {
    return formatLines(snapshot, command);
  }
  const lines = selectedLines(snapshot);
  if (lines.some(line => retainedLine.test(line.text))) return snapshot;
  if (command === 'bold' || command === 'italic' || command === 'strike' || command === 'inlineCode') return formatInline(snapshot, command);

  const { source, start, end } = snapshot;
  const text = source.slice(start, end);
  const eol = newline(source);
  const last = lines.at(-1)!;
  const afterLine = last.start + last.text.length;
  if (command === 'rule') return addBlock(snapshot, afterLine, afterLine, '---', 3 + 2 * eol.length, 3 + 2 * eol.length);
  if (command === 'codeBlock') {
    const body = text || '输入代码';
    const fence = '`'.repeat(Math.max(3, longestBackticks(body) + 1));
    const opening = fence + eol;
    const closing = (body.endsWith('\n') ? '' : eol) + fence;
    return addBlock(snapshot, text ? start : afterLine, text ? end : afterLine, opening + body + closing, opening.length, opening.length + body.length);
  }
  const useSelection = !!text && !/[\r\n|]/.test(text);
  const table = ['| 列名 | 列名 |', '| --- | --- |', `| ${useSelection ? text : '内容'} | 内容 |`].join(eol);
  if (!useSelection) return addBlock(snapshot, afterLine, afterLine, table, 2, 4);
  const cellStart = table.lastIndexOf(eol) + eol.length + 2;
  return addBlock(snapshot, start, end, table, cellStart, cellStart + text.length);
}

/** Return null for ordinary Enter so the textarea can retain its native editing behavior. */
export function markdownEnter(snapshot: MarkdownSnapshot): MarkdownSnapshot | null {
  if (snapshot.start !== snapshot.end) return null;
  const line = selectedLines(snapshot)[0];
  const list = listLine(line.text);
  if (!list || snapshot.start < line.start + list.end || !canContinueList(snapshot.source, line.start)) return null;
  if (!line.text.slice(list.end).trim()) {
    return replace(snapshot, line.start, line.start + line.text.length, list.indent.includes('>') ? list.indent : '');
  }
  let marker = list.marker;
  if (/^\d/.test(marker)) {
    const digits = marker.slice(0, -1);
    const next = Number(digits) + 1;
    marker = (next < 1000000000 ? String(next).padStart(digits.length, '0') : '1') + marker.at(-1);
  }
  const prefix = newline(snapshot.source) + list.indent + marker + (list.kind === 'task' ? ' [ ] ' : ' ');
  return replace(snapshot, snapshot.start, snapshot.end, prefix);
}

function canContinueList(source: string, lineStart: number) {
  try {
    let normalized = source.replace(/\r\n?/g, '\n');
    // Give the last item a line ending for lexical checks. At EOF Marked
    // otherwise replaces a trailing space on an empty item with a newline.
    if (!normalized.endsWith('\n')) normalized += '\n';
    const position = source.slice(0, lineStart).replace(/\r\n?/g, '\n').length;
    let offset = 0;
    for (const token of Lexer.lex(normalized, { gfm: true })) {
      const start = normalized.indexOf(token.raw, offset);
      if (start < 0 || start > position) break;
      offset = start + token.raw.length;
      if (position >= offset) continue;
      if (token.type !== 'list' && token.type !== 'blockquote') return false;
      // Inside a list or quotation the lexer removes structural indentation
      // from child spans. Match fence lines within this one enclosing block.
      let fence = '';
      for (const line of token.raw.slice(0, position - start).split('\n')) {
        const structural = listLine(line);
        const content = structural ? line.slice(structural.end) : line.replace(/^[ \t]*(?:>[ \t]*)*/, '');
        const match = /^(`{3,}|~{3,})(.*)$/.exec(content);
        if (!match) continue;
        if (fence) {
          if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = '';
        } else if (match[1][0] === '~' || !match[2].includes('`')) fence = match[1];
      }
      return !fence;
    }
  } catch { return false; }
  return false;
}

export function markdownIndent(snapshot: MarkdownSnapshot, outdent = false): MarkdownSnapshot {
  const lines = selectedLines(snapshot);
  if (snapshot.start === snapshot.end && !listLine(lines[0].text)) return snapshot;
  const edits = lines.flatMap(line => {
    if (retainedLine.test(line.text) || !line.text && lines.length > 1) return [];
    if (!outdent) return [{ start: line.start, end: line.start, text: '  ' }];
    const indent = /^(?: {1,2}|\t)/.exec(line.text)?.[0];
    return indent ? [{ start: line.start, end: line.start + indent.length, text: '' }] : [];
  });
  const next = editPrefixes(snapshot, edits);
  // Four leading spaces can turn an independent link into an indented code
  // block. The reverse edit can unintentionally activate a code example.
  return keepsCourseLinks(snapshot.source, next.source) ? next : snapshot;
}

function keepsCourseLinks(before: string, after: string, preserveText = false) {
  if (before === after || !/course/i.test(before) && !/course/i.test(after)) return true;
  const links = (source: string) => {
    if (!preserveText) return collectCourseMarkdownReferences(source).map(({ kind, id }) => `${kind}/${id}`);
    const references: string[] = [];
    walkTokens(Lexer.lex(source, { gfm: true }), token => {
      if (token.type !== 'link') return;
      const { href, raw } = token as Tokens.Link;
      if (parseCourseMarkdownReference(href)) references.push(href + '\n' + raw);
    });
    return references;
  };
  try {
    const previous = links(before), next = links(after);
    return previous.length === next.length && previous.every((link, index) => link === next[index]);
  } catch { return false; }
}

/** URL validation belongs to the caller. The same escaping is used for ordinary links throughout the editor. */
export function applyMarkdownLink(snapshot: MarkdownSnapshot, href: string, label?: string): MarkdownSnapshot {
  const { source, start, end } = snapshot;
  const text = source.slice(start, end);
  if (selectedLines(snapshot).some(line => retainedLine.test(line.text))) return snapshot;
  if (!/[\r\n]/.test(text)) {
    const link = courseMarkdownLink(text || label || '链接文字', href);
    const next = replace(snapshot, start, end, link, 1, link.lastIndexOf('](<'));
    // Selecting even part of an existing link can remove it or nest the new
    // URL in a managed label where readers would never see the ordinary link.
    if (keepsCourseLinks(source, next.source, true)) return next;
  }
  const link = courseMarkdownLink(label || '链接文字', href);
  const next = insertCourseMarkdownLine(source, end, link);
  if (!keepsCourseLinks(source, next.source, true)) return snapshot;
  // Standalone insertion leaves its caret after the block and a blank line.
  const linkStart = next.start - link.length - '\n\n'.length;
  return { source: next.source, start: linkStart + 1, end: linkStart + link.lastIndexOf('](<') };
}
