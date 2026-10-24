import type { ReactNode } from 'react';
import type { CourseMember, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { canManageOffering } from '@/lib/policy';
import { courseLabel } from '@/lib/course-label';
import { PageShell, type SiteUser } from './site-shell';
import { CourseNavigation, type CourseSection } from './course-navigation';
import styles from './course-frame.module.css';

type Offering = Prisma.CourseOfferingGetPayload<{ include: { course: true; term: true } }>;

export async function CourseFrame({ children, user, offering, membership, active }: {
  children: ReactNode;
  user: SiteUser & { id: string; isAdmin: boolean };
  offering: Offering;
  membership: CourseMember | null;
  active: CourseSection;
}) {
  const student = !user.isAdmin && membership?.role === 'STUDENT';
  const group = student ? await db.group.findFirst({
    where: { offeringId: offering.id, members: { some: { courseMemberId: membership.id, leftAt: null } } },
    select: { id: true },
  }) : null;
  return <PageShell currentUser={user} context="workspace" courseContext={{ label: courseLabel(offering.course, offering.term.name), fullName: `${offering.course.title} · ${offering.term.name}` }}>
    <div className={`container ${styles.frame}`} data-course-frame={active}>
      <aside className={styles.navigation}><CourseNavigation offeringId={offering.id} active={active} role={user.isAdmin ? undefined : membership?.role} canManage={canManageOffering(user.isAdmin, membership)} groupHref={group ? `/courses/${offering.id}/groups/${group.id}` : undefined} variant="sidebar"/></aside>
      <div className={styles.content}>{children}</div>
    </div>
  </PageShell>;
}
