import { isSafeCourseUrl } from './course-document';

type TextPart = { text: string; href?: string };

// Keep explicit URL boundaries conservative in prose. Query separators and
// Unicode path characters remain part of the address.
const proseBoundary = /[\p{Z}\t\r\n<>"'`，。！？；：（）【】《》“”‘’「」『』、]/u;
const startBoundary = /[\s,;([{"'<`，。！？；：（【《“‘「『、\p{Script=Han}]/u;
const forbidden = /[\\\p{Cc}\p{Bidi_Control}]/u;
const closing = new Map([['(', ')'], ['[', ']'], ['{', '}']]);

function candidateEnd(text: string, afterScheme: number, splitAdjacent: boolean) {
  const expected: string[] = [];
  let end = afterScheme;
  while (end < text.length) {
    const char = text[end];
    if (proseBoundary.test(char)) break;
    if (splitAdjacent && (char === ',' || char === ';') && /^https?:\/\//i.test(text.slice(end + 1, end + 9))) break;
    const close = closing.get(char);
    if (close) expected.push(close);
    else if (char === ')' || char === ']' || char === '}') {
      if (expected.at(-1) !== char) break;
      expected.pop();
    }
    end++;
  }
  return end;
}

/** All pieces are exact slices of the submitted text, including the displayed URL. */
export function submissionTextParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const schemes = /\b[a-z][a-z\d+.\-]{0,63}:/gi;
  let start = 0;
  for (let match = schemes.exec(text); match; match = schemes.exec(text)) {
    const at = match.index;
    const afterScheme = schemes.lastIndex;
    const http = /^https?:$/i.test(match[0]) && text.startsWith('//', afterScheme);
    const afterChineseLabel = text[at - 1] === ':' && /\p{Script=Han}:$/u.test(text.slice(Math.max(0, at - 3), at));
    const boundary = at === 0 || afterChineseLabel || startBoundary.test(text[at - 1]);
    // Consume other schemes and malformed candidates as a unit, so a nested
    // http address in e.g. ftp://host/?next=https://... cannot become a link.
    let end = candidateEnd(text, afterScheme, http && boundary);
    schemes.lastIndex = end;
    if (!http || !boundary) continue;
    const candidate = text.slice(at, end);
    const url = candidate.replace(/[.,!?;:]+$/, '');
    const authority = url.slice(match[0].length + 2).split(/[/?#]/, 1)[0];
    if (candidate.length > 2048 || !authority || authority.includes('@') || authority.startsWith('.') || authority.includes('..') ||
      forbidden.test(candidate) || /%(?![\da-f]{2})/i.test(url) || !isSafeCourseUrl(url)) continue;
    end = at + url.length;
    if (at > start) parts.push({ text: text.slice(start, at) });
    parts.push({ text: url, href: url });
    start = end;
  }
  if (start < text.length || !parts.length) parts.push({ text: text.slice(start) });
  return parts;
}
