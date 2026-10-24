'use server';

import type { FormState } from './form-state';
import { runCourseAction, refreshTeaching } from './action-utils';
import { saveCourseFocus } from './course-focus';

export async function saveCourseFocusAction(offeringId: string, _state: FormState, form: FormData): Promise<FormState> {
  return runCourseAction(async userId => {
    await saveCourseFocus(userId, offeringId, {
      title: String(form.get('title') ?? ''),
      body: String(form.get('body') ?? ''),
      assignmentIds: form.getAll('assignmentIds').map(value => String(value)),
      resourceIds: form.getAll('resourceIds').map(value => String(value)),
    });
    refreshTeaching(offeringId);
    return { success: '当前教学内容已更新。' };
  });
}
