/** The source is a course page ID, never an arbitrary return URL. */
export function parseGroupSource(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.length || value.length > 200 || value === '.' || value === '..') return;
  return /^[\p{L}\p{M}\p{N}._~-]+$/u.test(value) ? value : undefined;
}

export type LessonRecordOrigin = { includeWithdrawn?: boolean };

export type LessonRecordOriginQuery = { fromLessonRecords?: unknown; fromLessonRecordsWithdrawn?: unknown };

export function parseLessonRecordOrigin(query: LessonRecordOriginQuery): LessonRecordOrigin | undefined {
  if (query.fromLessonRecords === '1') return { includeWithdrawn: query.fromLessonRecordsWithdrawn === '1' };
}

export function setLessonRecordOrigin(params: URLSearchParams, origin?: LessonRecordOrigin) {
  if (origin) params.set('fromLessonRecords', '1');
  if (origin?.includeWithdrawn) params.set('fromLessonRecordsWithdrawn', '1');
}

export function groupWorkHref(offeringId: string, fromPage?: string, groupId?: string, recordOrigin?: LessonRecordOrigin): string {
  const base = `/courses/${encodeURIComponent(offeringId)}/groups`;
  const path = groupId ? `${base}/${encodeURIComponent(groupId)}` : base;
  const source = parseGroupSource(fromPage);
  if (!source) return path;
  const query = new URLSearchParams({ fromPage: source });
  setLessonRecordOrigin(query, recordOrigin);
  return `${path}?${query}`;
}

export function courseLessonHref(offeringId: string, pageId: string, records: boolean | LessonRecordOrigin = false, origin?: URLSearchParams): string {
  const path = `/courses/${encodeURIComponent(offeringId)}/pages/${encodeURIComponent(pageId)}`;
  const query = new URLSearchParams(origin);
  if (records) query.set('view', 'records');
  if (typeof records === 'object' && records.includeWithdrawn) query.set('includeWithdrawn', '1');
  return `${path}${query.size ? `?${query}` : ''}`;
}
