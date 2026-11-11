import { Fragment, type ReactNode } from 'react';
import { Lexer, type MarkedToken, type Token, type Tokens } from 'marked';
import { isSafeCourseUrl } from '@/lib/course-document';
import type { CourseDocumentCatalog } from '@/lib/course-document-view';
import { isCourseMarkdownHref, parseCourseMarkdownReference } from '@/lib/course-markdown-references';
import { CourseInlineRecord, CourseRecordView } from './course-record-view';

const headings = ['h2', 'h3', 'h4', 'h5', 'h6', 'h6'] as const;
type Context = { catalog?: CourseDocumentCatalog; editing: boolean };

function resolveReference(href: string, catalog?: CourseDocumentCatalog) {
  const reference = parseCourseMarkdownReference(href);
  const record = reference && catalog?.[reference.kind]?.find(item => item.id === reference.id);
  return reference && record ? { record, kind: reference.kind } : null;
}

// Only the stock lexer is used. No generated HTML enters the DOM.
function renderTokens(tokens: Token[], context: Context, topLevel = false): ReactNode[] {
  return tokens.flatMap((token, index) => {
    const node = renderToken(token as MarkedToken, context, topLevel);
    return node == null || (Array.isArray(node) && !node.length) ? [] : [<Fragment key={index}>{node}</Fragment>];
  });
}

function singleParagraphToken(tokens: Token[]) {
  const content = tokens.filter(token => token.type !== 'text' || /\S/u.test((token as Tokens.Text).text));
  return content.length === 1 ? content[0] as MarkedToken : undefined;
}

function safeImage(token: Tokens.Image) {
  return isSafeCourseUrl(token.href) && !token.href.startsWith('#');
}

function markdownImage(token: Tokens.Image) {
  return <img src={token.href} alt={token.text} title={token.title ?? undefined} loading="lazy" referrerPolicy="no-referrer"/>;
}

function renderToken(token: MarkedToken, context: Context, topLevel: boolean): ReactNode {
  switch (token.type) {
    case 'paragraph': {
      const only = topLevel ? singleParagraphToken(token.tokens) : undefined;
      if (only?.type === 'link' && isCourseMarkdownHref(only.href)) {
        const reference = resolveReference(only.href, context.catalog);
        return reference && <CourseRecordView {...reference} editing={context.editing}/>;
      }
      if (only?.type === 'image' && only.title && safeImage(only)) {
        return <figure data-markdown-image>{markdownImage(only)}<figcaption>{only.title}</figcaption></figure>;
      }
      const body = renderTokens(token.tokens, context);
      return body.length ? <p>{body}</p> : null;
    }
    case 'heading': {
      const Heading = headings[token.depth - 1];
      const body = renderTokens(token.tokens, context);
      return body.length ? <Heading>{body}</Heading> : null;
    }
    case 'text': return token.tokens ? renderTokens(token.tokens, context) : token.text;
    case 'html': case 'escape': return token.text;
    case 'strong': case 'em': case 'del': {
      const Mark = token.type;
      const body = renderTokens(token.tokens, context);
      return body.length ? <Mark>{body}</Mark> : null;
    }
    case 'br': return <br/>;
    case 'hr': return <hr/>;
    case 'codespan': return <code>{token.text}</code>;
    case 'code': return <pre><code>{token.text}</code></pre>;
    case 'blockquote': {
      const body = renderTokens(token.tokens, context);
      return body.length ? <blockquote>{body}</blockquote> : null;
    }
    case 'list': {
      const body = renderTokens(token.items, context);
      if (!body.length) return null;
      return token.ordered ? <ol start={typeof token.start === 'number' ? token.start : undefined}>{body}</ol> : <ul>{body}</ul>;
    }
    case 'list_item': {
      const body = renderTokens(token.tokens, context);
      return body.length ? <li>{body}</li> : null;
    }
    case 'checkbox': return <span role="img" aria-label={token.checked ? '已勾选' : '未勾选'}>{token.checked ? '☑ ' : '☐ '}</span>;
    case 'link': {
      if (isCourseMarkdownHref(token.href)) {
        const reference = resolveReference(token.href, context.catalog);
        return reference && <CourseInlineRecord {...reference} editing={context.editing}/>;
      }
      const label = renderTokens(token.tokens, context);
      if (!label.length) return null;
      return isSafeCourseUrl(token.href) ? <a href={token.href} title={token.title ?? undefined} {...(/^https?:/i.test(token.href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{label}</a> : label;
    }
    case 'image': return isCourseMarkdownHref(token.href) ? null : safeImage(token) ? markdownImage(token) : token.text;
    case 'table': return <div data-markdown-table><table>
      <thead><tr>{token.header.map((cell, i) => <th key={i} scope="col" style={{ textAlign: cell.align ?? undefined }}>{renderTokens(cell.tokens, context)}</th>)}</tr></thead>
      <tbody>{token.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} style={{ textAlign: cell.align ?? undefined }}>{renderTokens(cell.tokens, context)}</td>)}</tr>)}</tbody>
    </table></div>;
    case 'space': case 'def': return null;
  }
}

export function CourseMarkdownView({ source, catalog, editing = false }: { source: string; catalog?: CourseDocumentCatalog; editing?: boolean }) {
  try {
    return <>{renderTokens(Lexer.lex(source, { gfm: true }), { catalog, editing }, true)}</>;
  } catch {
    // A raw fallback could print an unavailable course reference's label.
    return catalog || /course:/iu.test(source) ? null : <pre>{source}</pre>;
  }
}
