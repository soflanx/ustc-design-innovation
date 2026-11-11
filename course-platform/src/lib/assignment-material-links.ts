export type AssignmentMaterialPart =
  | { text: string; resourceId?: undefined; raw?: undefined }
  | { text: string; resourceId: string; raw: string };

// Course records accept identifiers up to 200 code units. Permit Unicode names
// and unreserved path characters, but never separators, encodings or dot segments.
function validId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && id !== '.' && id !== '..' && !/[^\p{L}\p{M}\p{N}._~-]/u.test(id);
}

export function assignmentMaterialLink(offeringId: string, resource: { id: string; title: string }): string {
  const label = resource.title.replace(/[\\[\]]/g, '\\$&');
  if (!validId(offeringId) || !validId(resource.id)) return label;
  return `[${label}](/courses/${encodeURIComponent(offeringId)}/resources/${encodeURIComponent(resource.id)}/open)`;
}

function canonicalId(encoded: string): string | undefined {
  try {
    const id = decodeURIComponent(encoded);
    if (validId(id) && encodeURIComponent(id) === encoded) return id;
  } catch {
    // Keep malformed escapes as part of the original assignment text.
  }
}

// Labels allow exactly the escapes produced above and the 100 characters a
// resource title can contain. Each encoded ID uses at most 9 ASCII bytes per
// UTF-16 unit. Bounded, disjoint alternatives keep malformed input cheap to scan.
const encodedSegment = '[a-zA-Z0-9._~%-]{1,1800}';
const labelSource = /!?\[(?<label>(?:\\[\\[\]]|[^\\[\]]){1,100})\]\(/.source;
const materialSource = labelSource + `/courses/(?<offering>${encodedSegment})/resources/(?<resource>${encodedSegment})/open\\)`;
const codeOrEscape = /^ {0,3}(?<fence>`{3,}(?!`)(?=[^`\r\n]*$)|~{3,})(?<info>[^\r\n]*)|(?<blank>^[\t ]*\r?$)|\\[\\[\]!`]|(?<ticks>`+)/m;
const materialTokens = new RegExp(codeOrEscape.source + '|' + materialSource, 'gm');

// Inline code may span lines. Precompute closing delimiters so an unmatched
// backtick stays literal and cannot hide a later reference or trigger rescans.
function inlineCodeEnds(tokens: RegExpExecArray[]): Map<number, number> {
  const ends = new Map<number, number>();
  const nextRun = new Map<number, number>();
  for (let index = tokens.length - 1; index >= 0; index--) {
    const { ticks, fence, blank } = tokens[index].groups!;
    if (fence || blank !== undefined) nextRun.clear();
    if (!ticks) continue;
    const end = nextRun.get(ticks.length);
    if (end !== undefined) ends.set(index, end);
    nextRun.set(ticks.length, index);
  }
  return ends;
}

/** Scan the same canonical references for rendering and release planning. */
export function* assignmentMaterialReferences(description: string) {
  let fence = '';
  const tokens = Array.from(description.matchAll(materialTokens));
  const codeEnds = inlineCodeEnds(tokens);
  for (let index = 0; index < tokens.length; index++) {
    const match = tokens[index];
    const raw = match[0];
    const { fence: marker, info, ticks, label, offering: target, resource } = match.groups!;
    if (marker) {
      if (!fence) fence = marker;
      else if (marker.startsWith(fence) && !info.trim()) fence = '';
      continue;
    }
    if (fence) continue;
    if (ticks) {
      index = codeEnds.get(index) ?? index;
      continue;
    }
    if (!label || raw.startsWith('!')) continue;
    const resourceId = canonicalId(resource);
    const offeringId = canonicalId(target);
    if (!resourceId || !offeringId || !label.trim()) continue;
    yield { offeringId, resourceId, raw, text: label.replace(/\\([\\[\]])/g, '$1'), index: match.index };
  }
}

/** Splits only same-offering material references. Unrecognized source stays verbatim. */
export function splitAssignmentMaterialLinks(description: string, offeringId: string): AssignmentMaterialPart[] {
  const parts: AssignmentMaterialPart[] = [];
  if (!validId(offeringId)) return [{ text: description }];
  let textStart = 0;
  for (const { offeringId: target, resourceId, raw, text, index } of assignmentMaterialReferences(description)) {
    if (target !== offeringId) continue;
    if (index > textStart) parts.push({ text: description.slice(textStart, index) });
    parts.push({ text, resourceId, raw });
    textStart = index + raw.length;
  }
  if (textStart < description.length || !parts.length) parts.push({ text: description.slice(textStart) });
  return parts;
}

export function assignmentMaterialText(description: string, offeringId: string): string {
  return splitAssignmentMaterialLinks(description, offeringId).map(part => part.text).join('');
}
