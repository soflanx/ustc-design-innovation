'use server';

import { revalidatePath } from 'next/cache';
import { requireEditorAuthor, runCourseAction } from './action-utils';
import { saveGroupActivity, withdrawGroupActivity } from './group-activities';
import { groupWorkHref } from './group-work-link';
import { DomainError } from './management';
import { readResourceUpload } from './resource-file';
import { MAX_SUBMISSION_FILE_BYTES, MAX_SUBMISSION_FILES } from './submission-contract';

export async function saveGroupActivityAction(offeringId: string, groupId: string, expectedUserId: string, form: FormData) {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    const attachments = form.getAll('attachments');
    const files = attachments.filter((entry): entry is File => typeof entry !== 'string');
    if (files.length !== attachments.length || files.length > MAX_SUBMISSION_FILES) {
      throw new DomainError('请选择有效的附件，每次最多 20 件。');
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_SUBMISSION_FILE_BYTES) {
      throw new DomainError('附件合计不能超过 10 MiB。');
    }
    const uploads = [];
    for (const file of files) {
      const upload = await readResourceUpload(file);
      if (upload) uploads.push(upload);
    }
    const participants = form.getAll('participantIds');
    if (!participants.every(id => typeof id === 'string')) throw new DomainError('参与者无效，请重新选择。');
    const saved = await saveGroupActivity(userId, offeringId, groupId, {
      body: String(form.get('body') ?? ''),
      nextStep: String(form.get('nextStep') ?? ''),
      occurredOn: String(form.get('occurredOn') ?? ''),
      participantIds: participants,
      uploads,
      requestId: String(form.get('requestId') ?? ''),
    });
    revalidatePath(groupWorkHref(offeringId, undefined, groupId));
    if (saved.withdrawn) return { success: '这条记录已撤回。' };
    return { success: '已保存，本组成员和本期教学团队可以查看。' };
  });
}

export async function withdrawGroupActivityAction(offeringId: string, groupId: string, expectedUserId: string, activityId: string) {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    await withdrawGroupActivity(userId, offeringId, groupId, activityId);
    revalidatePath(groupWorkHref(offeringId, undefined, groupId));
    return { success: '已撤回记录。' };
  });
}
