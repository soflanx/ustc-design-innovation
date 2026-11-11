/** The source is a course page ID, never an arbitrary return URL. */
export function parseGroupSource(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.length || value.length > 200 || value === '.' || value === '..') return;
  return /^[\p{L}\p{M}\p{N}._~-]+$/u.test(value) ? value : undefined;
}

export function groupWorkHref(offeringId: string, fromPage?: string, groupId?: string): string {
  const base = `/courses/${encodeURIComponent(offeringId)}/groups`;
  const path = groupId ? `${base}/${encodeURIComponent(groupId)}` : base;
  const source = parseGroupSource(fromPage);
  return source ? `${path}?${new URLSearchParams({ fromPage: source })}` : path;
}

export function courseLessonHref(offeringId: string, pageId: string, records = false, origin?: URLSearchParams): string {
  const path = `/courses/${encodeURIComponent(offeringId)}/pages/${encodeURIComponent(pageId)}`;
  const query = new URLSearchParams(origin);
  if (records) query.set('view', 'records');
  return `${path}${query.size ? `?${query}` : ''}`;
}
