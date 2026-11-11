import type { ReactNode } from 'react';
import type { CourseMember, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { groupWorkHref } from '@/lib/group-work-link';
import { canManageOffering } from '@/lib/policy';
import { courseLabel, offeringCourseTitle } from '@/lib/course-label';
import { PageShell, type SiteUser } from './site-shell';
import { CourseNavigation, type CourseSection } from './course-navigation';
import styles from './course-frame.module.css';

type Offering = Prisma.CourseOfferingGetPayload<{ include: { course: true; term: true } }>;

export async function CourseFrame({ children, user, offering, membership, active, groupSourcePageId }: {
  children: ReactNode;
  user: SiteUser & { id: string; isAdmin: boolean };
  offering: Offering;
  membership: CourseMember | null;
  active: CourseSection;
  groupSourcePageId?: string;
}) {
  const student = !user.isAdmin && membership?.role === 'STUDENT';
  const teachingMember = membership?.status === 'ACTIVE' && (membership.role === 'TEACHER' || membership.role === 'TA');
  const group = student && !groupSourcePageId ? await db.group.findFirst({
    where: { offeringId: offering.id, members: { some: { courseMemberId: membership.id, leftAt: null } } },
    select: { id: true },
  }) : null;
  const groupHref = groupWorkHref(offering.id, groupSourcePageId, group?.id);
  const title = offeringCourseTitle(offering);
  return <PageShell currentUser={user} context="workspace" courseContext={{ label: courseLabel(offering.course, offering.term.name, offering.title), fullName: `${title} · ${offering.term.name}` }}>
    <div className={`container ${styles.frame}`} data-course-frame={active}>
      <aside className={styles.navigation}>
        <p className={styles.courseName}>{title}</p>
        <CourseNavigation offeringId={offering.id} active={active} role={user.isAdmin ? undefined : membership?.role}
          canManage={canManageOffering(user.isAdmin, membership)} canViewClassRecords={teachingMember} groupHref={groupHref} variant="sidebar"/>
      </aside>
      <div className={styles.content}>{children}</div>
    </div>
  </PageShell>;
}
