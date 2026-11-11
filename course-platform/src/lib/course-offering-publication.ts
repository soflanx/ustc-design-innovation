import { Prisma, type User } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { demoAuthEnabled } from './demo-config';
import { DomainError } from './management';
import { COURSE_PRESETS, getCoursePreset, presetOfferingTitle } from './course-presets';
import { loadUstcCalendar } from './ustc-calendar';

const publicationSchema = z.object({
  preset: z.enum(['thinking', 'practice']),
  termKey: z.string().regex(/^\d{4}-(spring|autumn)$/, '请选择有效的春季或秋季学期。'),
}).strict();

export type CoursePresetKey = z.infer<typeof publicationSchema>['preset'];
type Publisher = Pick<User, 'id' | 'isAdmin' | 'isDemo'>;

function canBootstrap(user: Publisher, isTeacher: boolean) {
  return user.isAdmin || isTeacher ||
    (demoAuthEnabled() && user.isDemo && user.id === 'demo-teacher');
}

/** The creation right does not grant ownership of an already existing course. */
export async function getPublishablePresetKeys(userId: string): Promise<CoursePresetKey[]> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, isAdmin: true, isDemo: true } });
  if (!user) return [];
  const teacher = await db.courseStaff.findFirst({ where: { userId, role: 'TEACHER' }, select: { courseId: true } });
  const courses = await db.course.findMany({
    where: { slug: { in: COURSE_PRESETS.map(preset => preset.slug) } },
    include: { staff: { where: { userId, role: 'TEACHER' }, select: { userId: true } } },
  });
  return COURSE_PRESETS.filter(preset => {
    const course = courses.find(item => item.slug === preset.slug);
    return course ? user.isAdmin || course.staff.length > 0 : canBootstrap(user, !!teacher);
  }).map(preset => preset.key);
}

export async function publishPresetCourse(userId: string, input: { preset: CoursePresetKey; termKey: string }) {
  const values = publicationSchema.parse(input);
  const preset = getCoursePreset(values.preset);
  if (!preset) throw new DomainError('请选择思维课或实践课。');
  // Only complete dates from the school's calendar can become a stored term.
  // Keep the network/calendar lookup outside a serializable database transaction.
  const calendar = (await loadUstcCalendar()).find(term => term.key === values.termKey);
  if (!calendar) throw new DomainError('本学期校历尚未同步，请稍后重试。');
  const startDate = new Date(`${calendar.startsOn}T00:00:00+08:00`);
  const endDate = new Date(`${calendar.endsOn}T23:59:59.999+08:00`);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate <= startDate) {
    throw new DomainError('本学期校历尚未同步，请稍后重试。');
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.$transaction(async tx => {
        const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, isAdmin: true, isDemo: true } });
        if (!user) throw new DomainError('请先登录教师账号后发布课程。');
        let course = await tx.course.findUnique({ where: { slug: preset.slug } });
        if (course) {
          const staff = await tx.courseStaff.findUnique({ where: { courseId_userId: { courseId: course.id, userId } } });
          if (!user.isAdmin && staff?.role !== 'TEACHER') throw new DomainError('只有本课程负责人或管理员可以发布课程。');
        } else {
          const teacher = await tx.courseStaff.findFirst({ where: { userId, role: 'TEACHER' }, select: { courseId: true } });
          if (!canBootstrap(user, !!teacher)) throw new DomainError('只有课程负责人或管理员可以发布课程。');
          course = await tx.course.create({ data: {
            slug: preset.slug, title: preset.title,
            staff: { create: { userId, role: 'TEACHER' } },
          } });
        }

        // A stable year/season key lets the two courses share one semester.
        // Existing calendar records are historical data and are not overwritten.
        let term = await tx.term.findUnique({ where: { slug: calendar.key } });
        if (!term) term = await tx.term.create({ data: {
          slug: calendar.key, name: calendar.name, startDate, endDate,
        } });
        const existing = await tx.courseOffering.findUnique({ where: { courseId_termId: { courseId: course.id, termId: term.id } } });
        // Repeated publication never clears teaching content or reopens archives.
        if (existing) return existing;

        const staff = await tx.courseStaff.findMany({ where: { courseId: course.id, role: 'TEACHER' }, select: { userId: true } });
        return tx.courseOffering.create({ data: {
          courseId: course.id, termId: term.id,
          title: `${presetOfferingTitle(values.preset, calendar.season)} · ${calendar.name}`,
          status: 'ACTIVE',
          members: { create: staff.map(person => ({ userId: person.userId, role: 'TEACHER' as const })) },
        } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code) && attempt < 4) continue;
      throw error;
    }
  }
  throw new DomainError('课程正在发布，请稍后重试。');
}
