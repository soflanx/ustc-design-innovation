import { db } from './db';
import { DomainError } from './management';
import type { CourseDocumentRecord } from './course-document-view';
import { getAssignmentIndex } from './teaching';
import { getCourseResource, getCourseResources } from './resource-service';
import { getAssignmentHomeItems, type AssignmentHomeContext } from './teaching-presentation';
import { toTeachingDateInput } from './teaching-format';

type Assignment = Awaited<ReturnType<typeof getAssignmentIndex>>['assignments'][number];
type Resource = Awaited<ReturnType<typeof getCourseResources>>['resources'][number];
export type AssignmentCatalogContext = AssignmentHomeContext & { canManageRecords: boolean; sourcePageId?: string };

function referenceProgress(assignment: Assignment, context: AssignmentCatalogContext): string | undefined {
  if (context.audience !== 'STUDENT' || context.offeringStatus !== 'ACTIVE'
    || assignment.status === 'DRAFT' || assignment.status === 'CANCELLED') return;
  const prefix = assignment.mode === 'GROUP' ? '本组' : '';
  switch (assignment.progress?.state) {
    case 'FEEDBACK_AVAILABLE': return prefix + '已有评语';
    case 'SUBMITTED': return prefix + '已提交';
    case 'UNGROUPED': return '尚未分组';
    case 'NOT_SUBMITTED': return prefix + '尚未提交';
  }
}

/** Shared presentation for the initial page and the result of an inline save. */
export function assignmentCatalogRecord(assignment: Assignment, context: AssignmentCatalogContext): CourseDocumentRecord {
  const { home } = getAssignmentHomeItems([assignment], context)[0];
  const ta = context.audience === 'TA';
  const path = `/courses/${encodeURIComponent(assignment.offeringId)}/assignments/${encodeURIComponent(assignment.id)}`;
  function withSource(href: string) {
    if (!context.sourcePageId) return href;
    const url = new URL(href, 'https://course.invalid');
    url.searchParams.set('fromPage', context.sourcePageId);
    return `${url.pathname}${url.search}${url.hash}`;
  }
  return {
    id: assignment.id, title: assignment.title, href: withSource(path),
    actionLabel: '查看作业要求', status: home.lifecycleLabel, lifecycleLabel: home.lifecycleLabel,
    visibilityStatus: assignment.status, lifecycleHint: home.lifecycleHint,
    assignmentMode: assignment.mode, progressHint: referenceProgress(assignment, context), deadline: assignment.dueAt?.toISOString(),
    subtitle: assignment.mode === 'GROUP' ? '小组提交' : '个人提交',
    scope: ta ? 'mine' : context.audience === 'STUDENT' ? 'self' : 'all',
    ...(assignment.status === 'CANCELLED' && assignment.cancellationReason ? { detail: `取消原因：${assignment.cancellationReason}` } : {}),
    ...(context.canManageRecords ? { assignment: {
      title: assignment.title, description: assignment.description, mode: assignment.mode,
      status: assignment.status, dueAt: toTeachingDateInput(assignment.dueAt), versionCount: assignment.versionCount,
      revision: assignment.revision, maxScore: assignment.maxScore, cancellationReason: assignment.cancellationReason,
    } } : {}),
  };
}

export function resourceReference(resource: Pick<Resource, 'id' | 'offeringId' | 'url'> & { file: { name: string } | null }): Required<Pick<CourseDocumentRecord,
  'href' | 'resourceFormat' | 'resourceAction' | 'actionLabel' | 'opensInNewTab'>> {
  const href = `/courses/${encodeURIComponent(resource.offeringId)}/resources/${encodeURIComponent(resource.id)}/open`;
  if (resource.file) {
    const format = resource.file.name.match(/\.([a-z0-9]{1,12})$/i)?.[1].toUpperCase() ?? '文件';
    const isPdf = format === 'PDF';
    return { href, resourceFormat: format, resourceAction: isPdf ? 'open' : 'download', actionLabel: isPdf ? '打开 PDF' : '下载文件', opensInNewTab: isPdf };
  }
  if (resource.url) return { href, resourceFormat: '外部链接', resourceAction: 'open', actionLabel: '打开链接', opensInNewTab: true };
  return { href, resourceFormat: '旧版文字 · TXT', resourceAction: 'download', actionLabel: '下载文字资料', opensInNewTab: false };
}

export function resourceCatalogRecord(resource: Resource, canManageRecords: boolean): CourseDocumentRecord {
  return {
    id: resource.id, title: resource.title, ...resourceReference(resource),
    visibilityStatus: resource.status,
    status: resource.status === 'DRAFT' ? '草稿 · 学生不可见' : resource.status === 'ARCHIVED' ? '已撤回 · 学生不可见' : '已发布',
    ...(canManageRecords ? { resource: {
      title: resource.title, body: resource.body, url: resource.url || '', file: resource.file, status: resource.status,
      revision: resource.revision, firstPublishedAt: resource.firstPublishedAt?.toISOString() ?? null,
    } } : {}),
  };
}

/** Reads are permission-filtered again; never turn an arbitrary record ID into a privileged catalog entry. */
export async function readCourseRecordCatalogEntry(userId: string, offeringId: string, kind: 'assignments' | 'resources', recordId: string): Promise<CourseDocumentRecord> {
  if (kind === 'resources') {
    const access = await getCourseResource(userId, offeringId, recordId);
    if (!access.resource) throw new DomainError('资料不可访问，请重新载入课程。');
    return resourceCatalogRecord(access.resource, access.canManage && access.offering.status !== 'ARCHIVED');
  }
  const [teaching, user] = await Promise.all([
    getAssignmentIndex(userId, offeringId),
    db.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
  ]);
  const assignment = teaching.assignments.find(record => record.id === recordId);
  if (!assignment || !user) throw new DomainError('作业不可访问，请重新载入课程。');
  return assignmentCatalogRecord(assignment, {
    audience: user.isAdmin ? 'ADMIN' : teaching.member!.role,
    offeringStatus: teaching.offering.status, canManageRecords: teaching.canManage,
  });
}
