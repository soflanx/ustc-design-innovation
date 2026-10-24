import { notFound } from 'next/navigation';
import { db } from './db';
import { requireUser } from './auth';
import { canManageOffering, canViewOffering } from './policy';

export async function getCourseMember(offeringId: string, userId: string) {
  return db.courseMember.findFirst({ where: { offeringId, userId } });
}

export async function requireOfferingAccess(offeringId: string, manage = false, returnTo = `/courses/${offeringId}`) {
  const user = await requireUser(returnTo);
  const [offering, membership] = await Promise.all([
    db.courseOffering.findUnique({ where: { id: offeringId }, include: { course: true, term: true } }),
    getCourseMember(offeringId, user.id),
  ]);
  if (!offering || !(manage ? canManageOffering(user.isAdmin, membership) : canViewOffering(user.isAdmin, membership))) notFound();
  return { user, offering, membership };
}

export async function requireCourseManager(courseId: string) {
  const user = await requireUser(`/manage/courses/${courseId}/new-offering`);
  const course = await db.course.findUnique({ where: { id: courseId } });
  const staff = await db.courseStaff.findFirst({ where: { courseId, userId: user.id } });
  if (!course || (!user.isAdmin && !staff)) notFound();
  return { user, course };
}
