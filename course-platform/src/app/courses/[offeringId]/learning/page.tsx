import { notFound } from 'next/navigation';
import { CourseFrame } from '@/components/course-frame';
import { StudentLearningView } from '@/components/student-learning';
import { requireOfferingAccess } from '@/lib/access';
import { DomainError } from '@/lib/management';
import { getStudentLearning } from '@/lib/student-learning';

export default async function StudentLearningPage({ params }: { params: Promise<{ offeringId: string }> }) {
  const { offeringId } = await params;
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, `/courses/${encodeURIComponent(offeringId)}/learning`);
  if (user.isAdmin || membership?.role !== 'STUDENT') notFound();
  let data;
  try { data = await getStudentLearning(user.id, offeringId); }
  catch (error) { if (error instanceof DomainError) notFound(); throw error; }
  return <CourseFrame user={user} offering={offering} membership={membership} active="learning"><StudentLearningView data={data}/></CourseFrame>;
}
