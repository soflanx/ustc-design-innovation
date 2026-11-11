'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentUser, requireSameOrigin } from './auth';
import { publishPresetCourse } from './course-offering-publication';
import type { FormState } from './form-state';
import { DomainError } from './management';

export async function publishPresetCourseAction(_state: FormState, form: FormData): Promise<FormState> {
  try {
    await requireSameOrigin();
    const user = await getCurrentUser();
    if (!user) return { error: '登录已过期，请重新登录后再发布。' };
    const preset = z.enum(['thinking', 'practice']).parse(form.get('preset'));
    const offering = await publishPresetCourse(user.id, { preset, termKey: String(form.get('termKey') ?? '') });
    revalidatePath('/');
    revalidatePath('/workspace');
    revalidatePath('/courses');
    revalidatePath(`/courses/${offering.id}`, 'layout');
    return { redirectTo: `/courses/${offering.id}` };
  } catch (error) {
    if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? '请选择课程和学期后重试。' };
    if (error instanceof DomainError) return { error: error.message };
    console.error('发布课程失败', error instanceof Error ? error.name : 'UnknownError');
    return { error: '暂时无法发布课程，请保留当前选择后重试。' };
  }
}
