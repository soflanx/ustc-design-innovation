import type { Prisma } from '@prisma/client';
import { collectCourseReferences, type CourseDocument } from './course-document';
import { summarizeCoursePublication, type CoursePublicationSummary } from './course-publication';
import { DomainError } from './management';

type PublicationDecision = { summary: CoursePublicationSummary; review?: never } | { review: CoursePublicationSummary; summary?: never };

/** The document has already been projected for this editor. Hidden identities never enter the summary. */
export async function checkCoursePagePublication(tx: Prisma.TransactionClient, offeringId: string, visible: CourseDocument, acknowledgedVisibility?: string): Promise<PublicationDecision> {
  const refs = collectCourseReferences(visible);
  const assignments = await tx.assignment.findMany({ where: { offeringId, id: { in: refs.assignmentIds } }, select: { id: true, status: true } });
  const resources = await tx.resource.findMany({ where: { offeringId, id: { in: refs.resourceIds } }, select: { id: true, status: true } });
  const pages = refs.pageIds.length ? await tx.courseSubpage.findMany({
    where: { offeringId, id: { in: refs.pageIds } }, select: { id: true, publishedAt: true },
  }) : [];
  const summary = summarizeCoursePublication(visible, {
    assignments: assignments.map(record => ({ id: record.id, visibilityStatus: record.status })),
    resources: resources.map(record => ({ id: record.id, visibilityStatus: record.status })),
    pages: pages.map(page => ({ id: page.id, visibilityStatus: page.publishedAt ? 'PUBLISHED' : 'DRAFT' })),
  });
  if (summary.unknownCount) throw new DomainError('有关联记录无法读取，请先核对后再发布。');
  if ((summary.needsConfirmation || acknowledgedVisibility !== undefined) && summary.key !== acknowledgedVisibility) return { review: summary };
  return { summary };
}
