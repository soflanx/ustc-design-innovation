import { createHash } from 'node:crypto';
import { Prisma, type User } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { demoAuthEnabled } from './demo-config';
import { DomainError } from './management';

const inputSchema = z.object({
  requestId: z.uuid('请重新打开创建课程页面后重试。'),
  title: z.string().trim().min(1, '请填写课程名称。').max(100, '课程名称请控制在 100 字以内。'),
  description: z.string().trim().max(2000, '课程介绍请控制在 2000 字以内。'),
});

type Creator = Pick<User, 'id' | 'isAdmin' | 'isDemo'>;

function allowedCreator(user: Creator | null, isCourseTeacher: boolean) {
  if (!user) return false;
  return user.isAdmin || isCourseTeacher ||
    (demoAuthEnabled() && user.isDemo && user.id === 'demo-teacher');
}

export async function canCreateCourse(userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, isAdmin: true, isDemo: true } });
  if (!user) return false;
  const teacher = await db.courseStaff.findFirst({ where: { userId, role: 'TEACHER' }, select: { courseId: true } });
  return allowedCreator(user, !!teacher);
}

export async function createCourse(userId: string, input: { requestId: string; title: string; description: string }) {
  const values = inputSchema.parse(input);
  // Scope retries to the actor; a guessed request ID cannot adopt another teacher's course.
  const id = 'course-' + createHash('sha256').update(userId + '\0' + values.requestId).digest('hex').slice(0, 40);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(async tx => {
        const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, isAdmin: true, isDemo: true } });
        const teacher = await tx.courseStaff.findFirst({ where: { userId, role: 'TEACHER' }, select: { courseId: true } });
        if (!allowedCreator(user, !!teacher)) throw new DomainError('只有课程负责人或管理员可以创建课程。');
        const existing = await tx.course.findUnique({ where: { id } });
        if (existing) {
          if (existing.title !== values.title || existing.description !== values.description) {
            throw new DomainError('这次创建请求已经成功，请返回我的课程继续开设学期。');
          }
          return existing;
        }
        return tx.course.create({ data: {
          id, slug: id, title: values.title, description: values.description,
          staff: { create: { userId, role: 'TEACHER' } },
        } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code) && attempt < 2) continue;
      throw error;
    }
  }
  throw new DomainError('创建尚未完成，请保留填写内容后重试。');
}
