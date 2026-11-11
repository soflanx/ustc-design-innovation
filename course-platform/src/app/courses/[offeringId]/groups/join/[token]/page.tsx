import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import styles from '@/app/group-space.module.css';
import { CourseFrame } from '@/components/course-frame';
import { JoinStudentGroupForm } from '@/components/group-formation';
import formationStyles from '@/components/group-formation.module.css';
import { requireOfferingAccess } from '@/lib/access';
import { db } from '@/lib/db';
import { getGroupFormationWindow, readGroupInvitation } from '@/lib/group-formation';
import { groupWorkHref } from '@/lib/group-work-link';
import { formatTeachingDate } from '@/lib/teaching-format';

// Keep the Origin on Safari's same-origin confirmation POST while hiding the link from other sites.
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: 'same-origin' };

export default async function GroupInvitationPage({ params }: { params: Promise<{ offeringId: string; token: string }> }) {
  const { offeringId, token } = await params;
  const groupsHref = groupWorkHref(offeringId);
  const invitationHref = `${groupsHref}/join/${encodeURIComponent(token)}`;
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, invitationHref);
  if (user.isAdmin || membership?.role !== 'STUDENT') notFound();
  const ownGroup = await db.groupMember.findFirst({
    where: { offeringId, courseMemberId: membership.id, leftAt: null },
    select: { group: { select: { id: true, name: true } } },
  });
  const formation = getGroupFormationWindow(offering);
  const invitation = formation && !ownGroup ? await readGroupInvitation(user.id, offeringId, token) : null;

  return <CourseFrame user={user} offering={offering} membership={membership} active="groups"><div className={styles.space}>
    <header className={styles.heading}>
      <Link className="breadcrumb" href={groupWorkHref(offeringId, undefined, ownGroup?.group.id)}>← 返回我的小组</Link>
      <h1>小组邀请</h1>
    </header>
    {ownGroup ? <p className="empty-state">你已加入「{ownGroup.group.name}」。如需调组，请<Link href={`/courses/${encodeURIComponent(offeringId)}/team`}>联系课程教师</Link>。</p>
      : formation && invitation ? <section className={`panel ${formationStyles.invitePreview}`}>
        <h2>{invitation.name}</h2>
        {invitation.note && <p className={formationStyles.description}>{invitation.note}</p>}
        {invitation.remaining > 0 ? <>
          <p className={formationStyles.note}>还可加入 {invitation.remaining} 人，开放至 <time dateTime={formation.closesAt.toISOString()}>{formatTeachingDate(formation.closesAt)}</time>。确认加入后，你将成为该组的正式成员。</p>
          <JoinStudentGroupForm offeringId={offeringId} expectedUserId={user.id} windowId={formation.id} target={{ inviteToken: token }}/>
        </> : <p className="field-help">这个小组已满。你可以返回我的小组查看其他招募。</p>}
      </section> : <p className="empty-state">这条邀请目前无法使用。返回我的小组查看本期组队情况。</p>}
  </div></CourseFrame>;
}
