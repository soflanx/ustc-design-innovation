import { createMarkdownBlock, expandCourseHomeLessonNotes, readMarkdownSource, type CourseBlock, type CourseDocument } from './course-document';
import { documentRecordIds, type CourseDocumentCatalog, type CourseDocumentRecord } from './course-document-view';
import { projectCourseMarkdownReferences } from './course-markdown-references';

/** A visibility preview, without impersonating a student or exposing staff progress. */
export function courseStudentPreview(document: CourseDocument, catalog: CourseDocumentCatalog) {
  const publicRecord = (record: CourseDocumentRecord, kind: 'assignments' | 'resources'): CourseDocumentRecord => ({
    id: record.id, title: record.title, href: `${record.href.match(/^\/courses\/[^/]+/)?.[0] ?? ''}/${kind}/${encodeURIComponent(record.id)}${kind === 'resources' ? '/open' : ''}`, subtitle: record.subtitle,
    lifecycleLabel: kind === 'assignments' ? record.lifecycleLabel : undefined,
    lifecycleHint: kind === 'assignments' ? record.lifecycleHint : undefined,
    deadline: kind === 'assignments' ? record.deadline : undefined,
    visibilityStatus: record.visibilityStatus,
    status: kind === 'resources' ? '已发布' : undefined,
    detail: kind === 'assignments' && record.visibilityStatus === 'CANCELLED' ? record.detail : undefined,
    actionLabel: kind === 'assignments' ? '查看作业' : record.actionLabel,
    ...(kind === 'resources' ? { resourceFormat: record.resourceFormat, resourceAction: record.resourceAction, opensInNewTab: record.opensInNewTab } : { assignmentMode: record.assignmentMode }),
  });
  const visible: CourseDocumentCatalog = {
    assignments: catalog.assignments.filter(record => ['PUBLISHED', 'ARCHIVED', 'CANCELLED'].includes(record.visibilityStatus ?? '')).map(record => publicRecord(record, 'assignments')),
    resources: catalog.resources.filter(record => record.visibilityStatus === 'PUBLISHED').map(record => publicRecord(record, 'resources')),
    groups: [],
    ...(catalog.pages && {
      pages: catalog.pages.filter(record => record.visibilityStatus === 'PUBLISHED')
        .map(({ id, title, href }) => ({ id, title, href })),
    }),
  };
  const readable = {
    assignments: new Set(visible.assignments.map(record => record.id)),
    resources: new Set(visible.resources.map(record => record.id)),
    groups: new Set<string>(),
    pages: new Set(visible.pages?.map(record => record.id)),
  };
  function blocks(items: CourseBlock[]): CourseBlock[] {
    return items.flatMap(block => {
      const children = blocks(block.children ?? []);
      if (block.type === 'protected') return children;
      if (block.type === 'markdown') {
        const source = readMarkdownSource(block);
        const projected = projectCourseMarkdownReferences(source, ({ kind, id }) => readable[kind].has(id));
        if (source === projected) return [{ ...block, children }];
        return projected.trim() ? [{ ...block, content: createMarkdownBlock(block.id, projected).content, children }] : children;
      }
      if (block.type !== 'courseRecord' && block.type !== 'courseData') return [{ ...block, children }];
      const kind = block.props.kind;
      if (kind === 'groups') return [{ id: block.id, type: 'paragraph' as const, props: {}, content: [{ type: 'text' as const, text: '仅所选小组的成员能看到自己组的入口。', styles: {} }], children }];
      if (kind !== 'assignments' && kind !== 'resources' && !(kind === 'pages' && block.type === 'courseRecord')) return children;
      const ids = new Set(visible[kind]?.map(record => record.id));
      if (block.type === 'courseRecord') return ids.has(String(block.props.recordId)) ? [{ ...block, children }] : children;
      const selected = documentRecordIds(block.props.ids).filter(id => ids.has(id));
      return selected.length ? [{ ...block, props: { ...block.props, ids: JSON.stringify(selected) }, children }] : children;
    });
  }
  const body = expandCourseHomeLessonNotes(document);
  return { document: { ...body, blocks: blocks(body.blocks) }, catalog: visible };
}
