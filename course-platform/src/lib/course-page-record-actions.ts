'use server';

import { refreshTeaching, runCourseAction } from './action-utils';
import { saveCoursePageAssignment, saveCoursePageResource, type CoursePageAssignmentInput, type CoursePageResourceInput } from './course-page-records';
import type { CourseDocumentRecord } from './course-document-view';
import { readCourseRecordCatalogEntry } from './course-record-catalog';
import { ResourceRevisionConflictError } from './resource-service';
import { AssignmentRevisionConflictError } from './teaching';

type Result =
  | { error: string; revisionConflict?: true; success?: never; record?: never }
  | { success: string; record: CourseDocumentRecord; error?: never; revisionConflict?: never };

async function saveRecord(
  offeringId: string, authorId: string, kind: 'assignments' | 'resources',
  write: (userId: string) => Promise<{ id: string; message: string }>,
): Promise<Result> {
  let record: CourseDocumentRecord | undefined;
  let revisionConflict: true | undefined;
  const result = await runCourseAction(async userId => {
    if (userId !== authorId) return { error: '登录账号已切换。请在另一标签页切回打开编辑器时的账号，再回来保存。' };
    try {
      const { id, message } = await write(userId);
      record = await readCourseRecordCatalogEntry(userId, offeringId, kind, id);
      refreshTeaching(offeringId);
      return { success: message };
    } catch (error) {
      if (error instanceof AssignmentRevisionConflictError || error instanceof ResourceRevisionConflictError) {
        revisionConflict = true;
        return { error: error.message };
      }
      throw error;
    }
  });
  if (!record || !result.success) return { error: result.error || '操作未完成，请保留编辑内容并重试。', revisionConflict };
  return { success: result.success, record };
}

export async function saveCoursePageAssignmentAction(offeringId: string, authorId: string, input: CoursePageAssignmentInput): Promise<Result> {
  return saveRecord(offeringId, authorId, 'assignments', async userId => {
    const { assignment } = await saveCoursePageAssignment(userId, offeringId, input);
    const status = assignment.status;
    const message = status === 'DRAFT' ? '作业草稿已保存。' : status === 'ARCHIVED' ? '作业已结束提交，已有记录保留。' : status === 'CANCELLED' ? '作业已取消，已有记录保留。' : '作业已发布。';
    return { id: assignment.id, message };
  });
}

export async function saveCoursePageResourceAction(offeringId: string, authorId: string, input: CoursePageResourceInput, upload?: FormData): Promise<Result> {
  return saveRecord(offeringId, authorId, 'resources', async userId => {
    const file = upload?.get('file');
    const { resource } = await saveCoursePageResource(userId, offeringId, file instanceof File ? { ...input, resource: { ...input.resource, file } } : input);
    return { id: resource.id, message: resource.status === 'DRAFT' ? '资料草稿已保存。' : resource.status === 'ARCHIVED' ? '资料已撤回。' : '资料已发布。' };
  });
}
