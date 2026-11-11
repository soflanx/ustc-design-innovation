import { Lexer, Tokenizer, type Token, type Tokens } from 'marked';

export type CourseMarkdownReferenceKind = 'pages' | 'assignments' | 'resources' | 'groups';
export type CourseMarkdownReference = { kind: CourseMarkdownReferenceKind; id: string };

export function isCourseMarkdownHref(href: unknown): boolean {
  return typeof href === 'string' && /^\s*course(?::|&#(?:x0*3a|0*58);|&colon;)/i.test(href);
}

export function parseCourseMarkdownReference(href: unknown): CourseMarkdownReference | null {
  if (typeof href !== 'string') return null;
  const match = /^course:(pages|assignments|resources|groups)\/([^/]+)$/u.exec(href);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[2]);
    if (!id || id.length > 200 || id === '.' || id === '..' || /[^\p{L}\p{M}\p{N}._~-]/u.test(id) || encodeURIComponent(id) !== match[2]) return null;
    return { kind: match[1] as CourseMarkdownReferenceKind, id };
  } catch {
    return null;
  }
}

export function courseMarkdownReferenceLink(kind: CourseMarkdownReferenceKind, id: string, title: string): string {
  const href = `course:${kind}/${encodeURIComponent(id)}`;
  if (!parseCourseMarkdownReference(href)) throw new Error('课程引用格式不正确。');
  const label = title.replace(/\s+/gu, ' ').trim().replace(/[\\\[\]*_`~&<>]/g, '\\$&');
  return `[${label || '查看课程内容'}](${href})`;
}

function childTokens(token: Token): Token[] {
  if (token.type === 'list') return (token as Tokens.List).items;
  if (token.type === 'table') {
    const table = token as Tokens.Table;
    return [table.header, ...table.rows].flatMap(row => row.flatMap(cell => cell.tokens));
  }
  return 'tokens' in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function walk(tokens: Token[], visit: (token: Token) => void | false): void {
  for (const token of tokens) {
    if (visit(token) !== false) walk(childTokens(token), visit);
  }
}

export class CourseMarkdownReferenceError extends Error {}

export function collectCourseMarkdownReferences(markdown: string, { strict = false } = {}): CourseMarkdownReference[] {
  const references: CourseMarkdownReference[] = [];
  if (!/course/i.test(markdown)) return references;
  try {
    walk(Lexer.lex(markdown, { gfm: true }), token => {
      if (token.type === 'image') return false;
      if (token.type !== 'link') return;
      const { href } = token as Tokens.Link;
      const reference = parseCourseMarkdownReference(href);
      if (strict && !reference && isCourseMarkdownHref(href)) throw new CourseMarkdownReferenceError('课程引用格式不正确，请修改链接或重新插入。');
      if (reference) references.push(reference);
    });
    return references;
  } catch (error) {
    // Extremely deep Markdown can exceed the parser's stack limit. The reader
    // also suppresses unparseable source containing the managed scheme.
    if (error instanceof CourseMarkdownReferenceError) throw error;
    if (strict) throw new CourseMarkdownReferenceError('Markdown 的嵌套过深，无法核对课程引用。');
    return [];
  }
}

class CourseReferenceTokenizer extends Tokenizer {
  definitions: Tokens.Def[] = [];

  override def(source: string) {
    const token = super.def(source);
    if (token) this.definitions.push(token);
    return token;
  }
}

type CourseMarkdownProjection = { source: string; protected?: { before: string; source: string; after: string; resourceIds: string[] } };

function rewriteTable(table: Tokens.Table, projected: string[]): string {
  let cellToken = 0;
  const rowSource = (row: Tokens.TableCell[]) => '| ' + row.map(cell => {
    const source = projected.slice(cellToken, cellToken + cell.tokens.length).join('');
    cellToken += cell.tokens.length;
    return source.replace(/\|/g, '\\|');
  }).join(' | ') + ' |';
  const alignment = { left: ':---', right: '---:', center: ':---:' };
  const divider = '| ' + table.align.map(align => align ? alignment[align] : '---').join(' | ') + ' |';
  return [rowSource(table.header), divider, ...table.rows.map(rowSource)].join('\n') + (table.raw.match(/\n*$/u)?.[0] ?? '');
}

/** Rewrite before serialization. A renderer alone cannot conceal source carried in an RSC payload. */
export function inspectCourseMarkdownVisibility(markdown: string, canRead: (reference: CourseMarkdownReference) => boolean, protectResources = false): CourseMarkdownProjection {
  if (!/course/i.test(markdown)) return { source: markdown };
  try {
    const tokenizer = new CourseReferenceTokenizer();
    const tokens = Lexer.lex(markdown, { gfm: true, tokenizer });
    const definitions = new Set<Tokens.Def>();
    const hiddenResources = new Set<string>();
    let firstPrivate = -1;
    let lastPrivate = -1;
    let inPrivateFragment = false;
    function rewrite(token: Token): string {
      if (token.type === 'link' || token.type === 'image' || token.type === 'def') {
        if (token.type === 'def') definitions.add(token as Tokens.Def);
        const href = (token as Tokens.Link | Tokens.Image | Tokens.Def).href;
        if (isCourseMarkdownHref(href)) {
          const reference = parseCourseMarkdownReference(href);
          const readable = reference !== null && canRead(reference);
          if (!readable && reference?.kind === 'resources') {
            hiddenResources.add(reference.id);
            inPrivateFragment = true;
          }
          if (!readable || token.type === 'image') return '';
        }
      }
      const children = childTokens(token);
      const projected = children.map(rewrite);
      if (projected.every((source, index) => source === children[index].raw)) return token.raw;
      if (token.type === 'table') return rewriteTable(token as Tokens.Table, projected);
      if (token.type === 'blockquote') {
        const body = projected.join('');
        return body.trim() ? body.split('\n').map(line => line ? `> ${line}` : '>').join('\n') : '';
      }
      const original = children.map(child => child.raw).join('');
      const start = token.raw.indexOf(original);
      // Inline tokens normally have a contiguous source span. Nested lists
      // can instead have synthetic spans after their indentation was removed.
      if (!original || start < 0 || token.raw.indexOf(original, start + 1) >= 0) return '';
      return token.raw.slice(0, start) + projected.join('') + token.raw.slice(start + original.length);
    }
    const pieces = tokens.map((token, index) => {
      inPrivateFragment = false;
      const source = rewrite(token);
      if (inPrivateFragment) {
        if (firstPrivate < 0) firstPrivate = index;
        lastPrivate = index;
      }
      return source;
    });
    // Marked discards shadowed definitions, including definitions inside a
    // quote. They can still be present in the original source of an RSC prop.
    let discardedPrivateDefinition = false;
    for (const definition of tokenizer.definitions) {
      if (definitions.has(definition) || !isCourseMarkdownHref(definition.href)) continue;
      const reference = parseCourseMarkdownReference(definition.href);
      if (reference && canRead(reference)) continue;
      if (reference?.kind === 'resources') hiddenResources.add(reference.id);
      discardedPrivateDefinition = true;
    }
    const originalPieces = tokens.map(token => token.raw);
    const result: CourseMarkdownProjection = { source: '' };
    if (protectResources && hiddenResources.size) {
      // A restricted paragraph or compound block stays intact and in order.
      // Definitions can bind across segments, so preserve their full source.
      const canSplit = firstPrivate >= 0 && !tokenizer.definitions.length && originalPieces.join('') === markdown;
      result.protected = {
        before: canSplit ? pieces.slice(0, firstPrivate).join('') : '',
        source: canSplit ? originalPieces.slice(firstPrivate, lastPrivate + 1).join('') : markdown,
        after: canSplit ? pieces.slice(lastPrivate + 1).join('') : '',
        resourceIds: [...hiddenResources],
      };
    }
    if (discardedPrivateDefinition) return result;
    if (pieces.every((source, index) => source === tokens[index].raw)) return { ...result, source: markdown };
    const source = pieces.join('');
    // Removing markup can change how adjacent fragments parse. Check the exact
    // serialized result before returning it to a less privileged reader.
    let safe = true;
    walk(Lexer.lex(source, { gfm: true }), token => {
      if (token.type !== 'link' && token.type !== 'image' && token.type !== 'def') return;
      const href = (token as Tokens.Link | Tokens.Image | Tokens.Def).href;
      if (!isCourseMarkdownHref(href)) return;
      const reference = parseCourseMarkdownReference(href);
      if (!reference || !canRead(reference) || token.type === 'image') safe = false;
    });
    return { ...result, source: safe ? source : '' };
  } catch {
    return protectResources ? { source: '', protected: { before: '', source: markdown, after: '', resourceIds: ['unparsed-markdown'] } } : { source: '' };
  }
}

export function projectCourseMarkdownReferences(markdown: string, canRead: (reference: CourseMarkdownReference) => boolean): string {
  return inspectCourseMarkdownVisibility(markdown, canRead).source;
}
