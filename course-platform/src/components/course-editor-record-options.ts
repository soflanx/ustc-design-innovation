import type { CourseDocumentCatalog } from '@/lib/course-document-view';

export function selectableRecords(catalog: CourseDocumentCatalog, kind: keyof CourseDocumentCatalog, { includePageDrafts = false } = {}) {
  return kind === 'pages'
    ? (catalog.pages ?? []).filter(page => page.visibilityStatus === 'PUBLISHED' || (includePageDrafts && page.visibilityStatus === 'DRAFT'))
    : catalog[kind];
}
