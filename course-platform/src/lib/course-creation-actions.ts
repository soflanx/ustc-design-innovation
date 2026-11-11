'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentUser, requireSameOrigin } from './auth';
import { createCourse } from './course-creation';
import type { FormState } from './form-state';
import { DomainError } from './management';

export async function createCourseAction(_state: FormState, form: FormData): Promise<FormState> {
  try {
    await requireSameOrigin();
    const user = await getCurrentUser();
    if (!user) return { error: '登录已过期，请重新登录后再创建。当前填写内容仍保留。' };
    const course = await createCourse(user.id, {
      requestId: String(form.get('requestId') ?? ''),
      title: String(form.get('title') ?? ''),
      description: String(form.get('description') ?? ''),
    });
    revalidatePath('/workspace');
    revalidatePath('/courses');
    return { redirectTo: `/manage/courses/${course.id}/new-offering` };
  } catch (error) {
    if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? '请检查填写内容。' };
    if (error instanceof DomainError) return { error: error.message };
    console.error('创建课程失败', error instanceof Error ? error.name : 'UnknownError');
    return { error: '暂时无法创建课程，已保留填写内容，请重试。' };
  }
}
