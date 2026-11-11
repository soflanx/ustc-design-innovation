import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { assignmentMaterialReferences } from './assignment-material-links';
import { authoredPageSnapshot, type CourseAuthoredSnapshot } from './course-authored-page';
import { collectCourseReferences } from './course-document';
import {
  commitCourseDocument, courseDocumentTransaction, prepareCourseDocument, type CourseDocumentInput,
} from './course-focus';
import { commitCourseSubpage, prepareCourseSubpage } from './course-subpages';
import { DomainError } from './management';
import { publishResourceDraftInTransaction } from './resource-service';
import { publishAssignmentDraftInTransaction } from './teaching';

export type CoursePublicationPlanRecord = {
  key: string;
  id: string;
  kind: 'assignments' | 'resources' | 'pages';
  title: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'CANCELLED';
  revision: number;
  selectable: boolean;
  source: 'page' | 'assignment' | 'both';
  deadline?: string | null;
  assignmentMode?: 'INDIVIDUAL' | 'GROUP';
};

export type CoursePublicationPlan = {
  key: string;
  records: CoursePublicationPlanRecord[];
  hasProtectedReferences: boolean;
};

type PreparedPage = {
  document: CourseDocumentInput['document'];
  title: string;
  revision: number;
  access: { readAllResources: boolean };
};

const identity = z.string().min(1).max(200);
const selection = z.object({ planKey: z.string().regex(/^[a-f0-9]{64}$/), selectedKeys: z.array(z.string().min(1).max(220)) });
const missingReference = () => new DomainError('有关联记录无法读取，请先核对后再发布。');

async function preparePage(tx: Prisma.TransactionClient, userId: string, offeringId: string, pageId: string | null, input: CourseDocumentInput) {
  identity.parse(offeringId);
  identity.nullable().parse(pageId);
  if (pageId === null) {
    const prepared = await prepareCourseDocument(tx, userId, offeringId, input);
    return { prepared, commit: () => commitCourseDocument(tx, offeringId, prepared, true) };
  }
  const prepared = await prepareCourseSubpage(tx, userId, offeringId, pageId, input);
  return { prepared, commit: () => commitCourseSubpage(tx, offeringId, pageId, prepared, true) };
}

async function buildPlan(tx: Prisma.TransactionClient, userId: string, offeringId: string, pageId: string | null, prepared: PreparedPage): Promise<CoursePublicationPlan> {
  const references = collectCourseReferences(prepared.document);
  const canManageRecords = prepared.access.readAllResources;
  const assignments = await tx.assignment.findMany({
    where: { offeringId, id: { in: references.assignmentIds } },
    select: { id: true, title: true, description: true, status: true, revision: true, dueAt: true, mode: true },
    orderBy: { id: 'asc' },
  });
  if (assignments.length !== references.assignmentIds.length) throw missingReference();

  const materialsByAssignment = assignments.map(assignment => {
    const ids = new Set<string>();
    for (const material of assignmentMaterialReferences(assignment.description)) {
      if (material.offeringId !== offeringId) throw missingReference();
      ids.add(material.resourceId);
    }
    return [assignment.id, [...ids].sort()] as const;
  });
  const materialIds = new Set(materialsByAssignment.flatMap(([, ids]) => ids));
  const pageResourceIds = new Set(references.resourceIds);
  const resourceIds = [...new Set([...pageResourceIds, ...materialIds])];
  const resources = await tx.resource.findMany({
    where: { offeringId, id: { in: resourceIds } },
    select: { id: true, title: true, status: true, revision: true },
    orderBy: { id: 'asc' },
  });
  if (resources.length !== resourceIds.length) throw missingReference();

  const pages = await tx.courseSubpage.findMany({
    where: { offeringId, id: { in: references.pageIds } },
    select: { id: true, title: true, draftTitle: true, publishedAt: true, revision: true },
    orderBy: { id: 'asc' },
  });
  if (pages.length !== references.pageIds.length) throw missingReference();

  const records: CoursePublicationPlanRecord[] = [
    ...assignments.map(({ id, title, status, revision, dueAt, mode }): CoursePublicationPlanRecord => ({
      key: `assignments:${id}`, id, title, status, revision, kind: 'assignments',
      deadline: dueAt?.toISOString() ?? null, assignmentMode: mode,
      source: 'page', selectable: canManageRecords && status === 'DRAFT',
    })),
    ...resources.filter(record => canManageRecords || record.status === 'PUBLISHED').map(({ id, title, status, revision }): CoursePublicationPlanRecord => ({
      key: `resources:${id}`, id, title, status, revision, kind: 'resources',
      source: pageResourceIds.has(id) ? materialIds.has(id) ? 'both' : 'page' : 'assignment',
      selectable: canManageRecords && status === 'DRAFT',
    })),
    ...pages.map(({ id, title, draftTitle, publishedAt, revision }): CoursePublicationPlanRecord => ({
      key: `pages:${id}`, id, title: publishedAt ? title : draftTitle ?? title, revision, kind: 'pages',
      status: publishedAt ? 'PUBLISHED' : 'DRAFT', source: 'page', selectable: false,
    })),
  ];
  const key = createHash('sha256').update(JSON.stringify({
    userId, offeringId, pageId, revision: prepared.revision, title: prepared.title, document: prepared.document,
    canManageRecords, materialsByAssignment,
    assignments: assignments.map(({ id, status, revision }) => [id, status, revision]),
    resources: resources.map(({ id, status, revision }) => [id, status, revision]),
    pages: pages.map(({ id, publishedAt, revision }) => [id, publishedAt, revision]),
  })).digest('hex');
  return { key, records, hasProtectedReferences: !canManageRecords && resources.some(record => record.status !== 'PUBLISHED') };
}

export async function previewCoursePublicationPlan(userId: string, offeringId: string, pageId: string | null, input: CourseDocumentInput): Promise<CoursePublicationPlan> {
  return courseDocumentTransaction(async tx => {
    const { prepared } = await preparePage(tx, userId, offeringId, pageId, input);
    return buildPlan(tx, userId, offeringId, pageId, prepared);
  });
}

export async function applyCoursePublicationPlan(userId: string, offeringId: string, pageId: string | null, input: CourseDocumentInput, planKey: string, selectedKeys: string[]): Promise<{ page?: CourseAuthoredSnapshot; plan?: CoursePublicationPlan }> {
  const confirmed = selection.parse({ planKey, selectedKeys });
  return courseDocumentTransaction(async tx => {
    const { prepared, commit } = await preparePage(tx, userId, offeringId, pageId, input);
    const plan = await buildPlan(tx, userId, offeringId, pageId, prepared);
    if (plan.key !== confirmed.planKey) return { plan };

    const selected = new Set(confirmed.selectedKeys);
    const records = plan.records.filter(record => record.selectable && selected.has(record.key));
    if (records.length !== confirmed.selectedKeys.length) throw new DomainError('发布选择无效，请重新核对。');

    // Review and selection validation are complete before any write. From here
    // every failure must throw, so neither the records nor the page can commit alone.
    for (const record of records) {
      if (record.kind === 'assignments') await publishAssignmentDraftInTransaction(tx, userId, offeringId, record.id, record.revision);
      else await publishResourceDraftInTransaction(tx, userId, offeringId, record.id, record.revision);
    }
    return { page: authoredPageSnapshot(await commit()) };
  });
}
