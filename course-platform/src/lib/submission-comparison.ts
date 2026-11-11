import { submissionTextParts } from './submission-links';

/** Callers supply only the finalized versions the current viewer may read. */
export function previousSubmissionVersions<T extends { id: string; submissionId: string; version: number }>(
  versions: readonly T[],
): Map<string, T> {
  const bySubmission = new Map<string, Map<number, T>>();
  for (const version of versions) {
    let series = bySubmission.get(version.submissionId);
    if (!series) {
      series = new Map();
      bySubmission.set(version.submissionId, series);
    }
    series.set(version.version, version);
  }
  const previous = new Map<string, T>();
  for (const version of versions) {
    if (version.version < 2) continue;
    const predecessor = bySubmission.get(version.submissionId)?.get(version.version - 1);
    if (predecessor) previous.set(version.id, predecessor);
  }
  return previous;
}

type Passage = { previous: string; current: string };
type Comparison = { passages: Passage[]; mode: 'identical' | 'passages' | 'range' };
const maxAlignmentCells = 65536;

function sentences(body: string): string[] {
  // Locate sentence boundaries without treating punctuation inside a link as
  // a sentence ending. Keep UTF-16 offsets so each slice is the original text.
  const boundaries = submissionTextParts(body).map(part => part.href ? 'x'.repeat(part.text.length) : part.text).join('');
  const sentence = /[^。！？.!?\r\n]+[。！？.!?]*[\r\n]*|[。！？.!?]+[\r\n]*|[\r\n]+/g;
  return Array.from(boundaries.matchAll(sentence), match => body.slice(match.index, match.index + match[0].length));
}

export function compareSubmissionBodies(previous: string, current: string): Comparison {
  if (previous === current) return { mode: 'identical', passages: [] };
  const oldText = sentences(previous), newText = sentences(current);
  // Browser form submission can change the newline encoding of otherwise
  // identical paragraphs. Align by these keys, but display the original text.
  const newlineKey = (text: string) => text.replace(/\r\n?/g, '\n');
  const oldKeys = oldText.map(newlineKey), newKeys = newText.map(newlineKey);
  let start = 0, oldEnd = oldText.length, newEnd = newText.length;
  while (start < oldEnd && start < newEnd && oldKeys[start] === newKeys[start]) start++;
  if (start === oldEnd && start === newEnd) return { mode: 'identical', passages: [] };
  while (oldEnd > start && newEnd > start && oldKeys[oldEnd - 1] === newKeys[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const left = oldText.slice(start, oldEnd), right = newText.slice(start, newEnd);
  const width = right.length + 1;
  const cells = (left.length + 1) * width;
  if (cells > maxAlignmentCells || !left.length || !right.length) {
    return {
      mode: cells > maxAlignmentCells ? 'range' : 'passages',
      passages: [{ previous: left.join(''), current: right.join('') }],
    };
  }

  // Align equal sentences in order (longest common subsequence). Pathological
  // inputs fall back above to neutral before/after ranges, with bounded memory.
  const matches = (i: number, j: number) => oldKeys[start + i] === newKeys[start + j];
  const lengths = new Uint16Array(cells);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      const cell = i * width + j;
      lengths[cell] = matches(i, j)
        ? 1 + lengths[cell + width + 1]
        : Math.max(lengths[cell + width], lengths[cell + 1]);
    }
  }

  const passages: Passage[] = [];
  let i = 0, j = 0, oldStart = 0, newStart = 0;
  function collect(oldStop: number, newStop: number) {
    if (oldStop === oldStart && newStop === newStart) return;
    passages.push({ previous: left.slice(oldStart, oldStop).join(''), current: right.slice(newStart, newStop).join('') });
  }
  while (i < left.length && j < right.length) {
    if (matches(i, j)) {
      collect(i, j);
      i++;
      j++;
      oldStart = i;
      newStart = j;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  collect(left.length, right.length);
  return { mode: 'passages', passages };
}
