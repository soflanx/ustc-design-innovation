import { z } from 'zod';
import { DomainError } from './management';
import { changeAssignmentStatus, createAssignment, updateAssignment, type AssignmentInput } from './teaching';
import { parseTeachingDateInput } from './teaching-format';
import { changeResourceStatus, createResource, updateResource, type ResourceInput } from './resource-service';

export type CoursePageAssignmentInput = {
  requestId?: string;
  expectedRevision?: number;
  statusOnly?: boolean;
  assignment: Omit<AssignmentInput, 'dueAt'> & { id?: string; dueAt: string };
};
export type CoursePageResourceInput = {
  requestId?: string;
  expectedRevision?: number;
  statusOnly?: boolean;
  resource: ResourceInput & { id?: string };
};

const request = z.object({
  requestId: z.uuid('创建标识无效，请重新打开新建窗口。').optional(),
  expectedRevision: z.number().int().min(1).optional(),
  statusOnly: z.boolean().optional(),
});
const recordId = z.string().min(1).max(200);
const assignmentStatus = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED', 'CANCELLED']);
const resourceStatus = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
const cancellationReason = z.string().max(2000).nullable().optional();
const assignmentRequest = request.extend({ assignment: z.object({
  id: recordId.optional(), title: z.string(), description: z.string(), mode: z.enum(['INDIVIDUAL', 'GROUP']),
  status: assignmentStatus, dueAt: z.string().max(16), cancellationReason, maxScore: z.number().optional(),
}) });
const resourceRequest = request.extend({ resource: z.object({
  id: recordId.optional(), title: z.string(), body: z.string(), url: z.string(), status: resourceStatus, file: z.file().optional(),
}) });
const assignmentStatusRequest = request.extend({ assignment: z.object({ id: recordId, status: assignmentStatus, cancellationReason }) });
const resourceStatusRequest = request.extend({ resource: z.object({ id: recordId, status: resourceStatus }) });

function editRevision(value: number | undefined): number {
  if (value === undefined) throw new DomainError('请重新打开记录后保存，缺少有效的记录版本。');
  return value;
}
function createRequestId(value: string | undefined): string {
  if (!value) throw new DomainError('请重新打开新建窗口，缺少创建标识。');
  return value;
}

/** Record writes never save, publish, or require a course-page document. */
export async function saveCoursePageAssignment(userId: string, offeringId: string, input: CoursePageAssignmentInput) {
  if (request.parse(input).statusOnly) {
    // Ignore form text entirely: a lifecycle action cannot replace requirements
    // with an old editor snapshot, nor be blocked by unrelated invalid fields.
    const values = assignmentStatusRequest.parse(input);
    const assignment = await changeAssignmentStatus(userId, offeringId, values.assignment.id, {
      status: values.assignment.status, cancellationReason: values.assignment.cancellationReason,
      expectedRevision: editRevision(values.expectedRevision),
    });
    return { assignment };
  }
  const values = assignmentRequest.parse(input);
  const { id, ...fields } = values.assignment;
  let dueAt: Date | null;
  try { dueAt = parseTeachingDateInput(fields.dueAt); }
  catch { throw new DomainError('请填写有效的截止时间（北京时间）。'); }
  const assignment = id
    ? await updateAssignment(userId, offeringId, id, { ...fields, dueAt }, editRevision(values.expectedRevision))
    : await createAssignment(userId, offeringId, { ...fields, dueAt }, createRequestId(values.requestId));
  return { assignment };
}

export async function saveCoursePageResource(userId: string, offeringId: string, input: CoursePageResourceInput) {
  if (request.parse(input).statusOnly) {
    const values = resourceStatusRequest.parse(input);
    const resource = await changeResourceStatus(userId, offeringId, values.resource.id, {
      status: values.resource.status, expectedRevision: editRevision(values.expectedRevision),
    });
    return { resource };
  }
  const values = resourceRequest.parse(input);
  const { id, ...fields } = values.resource;
  const resource = id
    ? await updateResource(userId, offeringId, id, fields, editRevision(values.expectedRevision))
    : await createResource(userId, offeringId, fields, createRequestId(values.requestId));
  return { resource };
}
