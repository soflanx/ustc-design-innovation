'use server';

import { refreshTeaching, requireEditorAuthor, runCourseAction } from './action-utils';
import type { FormState } from './form-state';
import {
  correctTeachingObservation, recordLessonStudentEvents, recordTeachingObservation, sendTeachingFeedback, withdrawTeachingObservation,
  type LessonStudentEventRecord, type LessonStudentEventsInput, type TeachingFeedbackInput, type TeachingNoteInput,
  type TeachingObservationCorrection, type TeachingObservationWithdrawal,
} from './teaching-observations';

export async function recordTeachingObservationAction(offeringId: string, expectedUserId: string, input: TeachingNoteInput): Promise<FormState & { recordId?: string }> {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    const { id } = await recordTeachingObservation(userId, offeringId, input);
    refreshTeaching(offeringId);
    return { success: '内部记录已保存。', recordId: id };
  });
}

export async function recordLessonStudentEventsAction(offeringId: string, expectedUserId: string, input: LessonStudentEventsInput): Promise<FormState & { records?: LessonStudentEventRecord[] }> {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    const { records } = await recordLessonStudentEvents(userId, offeringId, input);
    refreshTeaching(offeringId);
    return { success: `已为 ${records.length} 位学生保存记录。`, records };
  });
}

export async function correctTeachingObservationAction(offeringId: string, expectedUserId: string, observationId: string, input: TeachingObservationCorrection) {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    await correctTeachingObservation(userId, offeringId, observationId, input);
    refreshTeaching(offeringId);
    return { success: '更正已保存。' };
  });
}

export async function withdrawTeachingObservationAction(offeringId: string, expectedUserId: string, observationId: string, input: TeachingObservationWithdrawal) {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    await withdrawTeachingObservation(userId, offeringId, observationId, input);
    refreshTeaching(offeringId);
    return { success: '记录已撤回。' };
  });
}

export async function sendTeachingFeedbackAction(offeringId: string, expectedUserId: string, input: TeachingFeedbackInput) {
  return runCourseAction(async userId => {
    requireEditorAuthor(userId, expectedUserId ?? '');
    await sendTeachingFeedback(userId, offeringId, input);
    refreshTeaching(offeringId);
    return { success: '反馈已发送。' };
  });
}
