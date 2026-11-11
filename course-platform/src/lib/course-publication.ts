import { collectCourseReferences, type CourseBlock, type CourseDocument } from './course-document';
import type { CourseDocumentRecord } from './course-document-view';

type RecordStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'CANCELLED';
export type CoursePublicationSummary = {
  assignments: { total: number; draft: number; published: number; ended: number; cancelled: number; unknown: number };
  resources: { total: number; draft: number; published: number; withdrawn: number; unknown: number };
  pages: { total: number; published: number; draft: number; unknown: number };
  hasProtectedReferences: boolean;
  hiddenCount: number;
  unknownCount: number;
  needsConfirmation: boolean;
  /** Compare exact referenced identities/states, not just equal-looking counts. Never display it. */
  key: string;
};

type PublicationRecord = Pick<CourseDocumentRecord, 'id' | 'visibilityStatus'>;

/** Permission-filtered catalogs only. Counts never carry record titles or bodies. */
export function summarizeCoursePublication(document: CourseDocument, catalog: { assignments: PublicationRecord[]; resources: PublicationRecord[]; pages?: PublicationRecord[] }): CoursePublicationSummary {
  const references = collectCourseReferences(document);
  const assignments = { total: references.assignmentIds.length, draft: 0, published: 0, ended: 0, cancelled: 0, unknown: 0 };
  const resources = { total: references.resourceIds.length, draft: 0, published: 0, withdrawn: 0, unknown: 0 };
  const pages = { total: references.pageIds.length, published: 0, draft: 0, unknown: 0 };
  const assignmentStates = new Map(catalog.assignments.map(record => [record.id, record.visibilityStatus]));
  const resourceStates = new Map(catalog.resources.map(record => [record.id, record.visibilityStatus]));
  const pageStates = new Map(catalog.pages?.map(record => [record.id, record.visibilityStatus]));
  for (const id of references.assignmentIds) {
    const status = assignmentStates.get(id);
    if (status === 'DRAFT') assignments.draft++;
    else if (status === 'PUBLISHED') assignments.published++;
    else if (status === 'ARCHIVED') assignments.ended++;
    else if (status === 'CANCELLED') assignments.cancelled++;
    else assignments.unknown++;
  }
  for (const id of references.resourceIds) {
    const status = resourceStates.get(id);
    if (status === 'DRAFT') resources.draft++;
    else if (status === 'PUBLISHED') resources.published++;
    else if (status === 'ARCHIVED') resources.withdrawn++;
    else resources.unknown++;
  }
  for (const id of references.pageIds) {
    const status = pageStates.get(id);
    if (status === 'PUBLISHED') pages.published++;
    else if (status === 'DRAFT') pages.draft++;
    else pages.unknown++;
  }
  const protectedIds = new Set<string>();
  const visit = (blocks: CourseBlock[]) => blocks.forEach(block => {
    if (block.type === 'protected') protectedIds.add(block.id);
    visit(block.children ?? []);
  });
  visit(document.blocks);
  const hiddenCount = assignments.draft + resources.draft + resources.withdrawn + pages.draft;
  const unknownCount = assignments.unknown + resources.unknown + pages.unknown;
  return {
    assignments, resources, pages, hasProtectedReferences: protectedIds.size > 0,
    hiddenCount, unknownCount, needsConfirmation: hiddenCount > 0 || unknownCount > 0 || protectedIds.size > 0,
    key: JSON.stringify({
      assignments: [...references.assignmentIds].sort().map(id => [id, assignmentStates.get(id) ?? 'UNKNOWN']),
      resources: [...references.resourceIds].sort().map(id => [id, resourceStates.get(id) ?? 'UNKNOWN']),
      pages: [...references.pageIds].sort().map(id => [id, pageStates.get(id) ?? 'UNKNOWN']),
      protected: [...protectedIds].sort(),
    }),
  };
}

export function courseRecordSaveImpact(kind: 'assignments' | 'resources', nextStatus: RecordStatus, originalStatus?: RecordStatus): string {
  const assignment = kind === 'assignments';
  if (nextStatus === 'DRAFT') {
    if (!assignment && originalStatus === 'PUBLISHED') return '保存后资料转为草稿，学生和助教立即无法读取；页面草稿不会延迟生效。';
    return assignment
      ? '只保存这份作业草稿，学生不可见；可在课次发布时选择一并发布。'
      : '只保存这份资料草稿，学生和助教不可见；可在课次发布时选择一并发布。';
  }
  if (nextStatus === 'CANCELLED') return originalStatus === 'CANCELLED'
    ? '保存后立即更新这份已取消作业，学生仍免交，已有提交和反馈保留；页面草稿不会延迟生效。'
    : '保存后立即取消作业，学生不再需要完成，已有提交和反馈保留；页面草稿不会延迟生效。';
  if (nextStatus === 'ARCHIVED') {
    if (assignment) return originalStatus === 'ARCHIVED'
      ? '保存后立即更新这份已结束作业，仍不接受新提交；学生可查看要求与历史，页面草稿不会延迟生效。'
      : '保存后立即结束提交，学生仍可查看要求、提交和反馈；页面草稿不会延迟生效。';
    return originalStatus === 'ARCHIVED'
      ? '保存这份已撤回资料的修改，学生和助教仍不可见；发布页面不会重新发布资料。'
      : '保存后立即撤回资料，学生和助教无法读取；页面草稿不会延迟生效。';
  }
  if (originalStatus === 'PUBLISHED') return assignment
    ? '正在修改已发布作业。保存后立即更新学生可见要求，页面草稿不会延迟生效。'
    : '正在修改已发布资料。保存后立即更新学生和助教可见的资料，页面草稿不会延迟生效。';
  if (assignment && originalStatus === 'CANCELLED') return '保存后立即恢复发布，学生重新需要完成；页面草稿不会延迟生效，能否提交仍取决于课程状态与截止时间。';
  if (assignment && originalStatus === 'ARCHIVED') return '保存后立即恢复发布；页面草稿不会延迟生效，能否提交仍取决于课程状态与截止时间。';
  return assignment
    ? '保存后作业立即对学生可见，可从作业列表打开；尚未发布的页面编排仍需另行发布。'
    : '保存后资料立即对学生和助教可见，可从资料列表打开；尚未发布的页面编排仍需另行发布。';
}
