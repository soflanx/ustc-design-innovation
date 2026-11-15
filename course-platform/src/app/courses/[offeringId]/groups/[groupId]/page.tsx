import Link from 'next/link';
import styles from '@/app/group-space.module.css';
import { notFound } from 'next/navigation';
import { requireOfferingAccess } from '@/lib/access';
import { db } from '@/lib/db';
import { canViewGroup, displayDate, isActiveTeachingMember } from '@/lib/policy';
import { DomainError, getGroupPageHistory } from '@/lib/management';
import { CourseFrame } from '@/components/course-frame';
import { GroupRecruitment } from '@/components/group-formation';
import { GroupPageEditor } from '@/components/group-page-editor';
import { GroupActivities } from '@/components/group-activities';
import { TeachingObservationPanel } from '@/components/teaching-observation-panel';
import { TeachingObservationForm } from '@/components/teaching-observation-form';
import readingStyles from '@/components/teaching-history.module.css';
import { getTeachingHistory } from '@/lib/teaching-history';
import { getGroupFormationWindow } from '@/lib/group-formation';
import { getGroupActivities } from '@/lib/group-activities';
import { showcaseWorkspaceHref } from '@/lib/group-showcase-contract';
import { groupWorkHref, setLessonRecordOrigin } from '@/lib/group-work-link';
import { getGroupWorkOrigin, groupWorkOriginParams, type GroupWorkOriginQuery } from '@/lib/group-work-origin';
import { getStudentLearning } from '@/lib/student-learning';
import { formatTeachingDate } from '@/lib/teaching-format';

export default async function GroupPage({ params, searchParams }: {
  params: Promise<{ offeringId: string; groupId: string }>;
  searchParams: Promise<GroupWorkOriginQuery & { includeWithdrawn?: unknown }>;
}) {
  const { offeringId, groupId } = await params;
  const query = await searchParams;
  const includeWithdrawn = query.includeWithdrawn === '1';
  const returnTo = groupWorkOriginParams(query);
  const groupPath = groupWorkHref(offeringId, undefined, groupId);
  const withdrawnQuery = new URLSearchParams(returnTo);
  withdrawnQuery.set('includeWithdrawn', '1');
  const currentHref = `${groupPath}${returnTo.size ? `?${returnTo}` : ''}`;
  const withdrawnHref = `${groupPath}?${withdrawnQuery}`;
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, includeWithdrawn ? withdrawnHref : currentHref);
  const own = membership ? !!await db.groupMember.findFirst({ where: { offeringId, groupId, courseMemberId: membership.id, leftAt: null } }) : false;
  if (!canViewGroup(user.isAdmin, membership, own)) notFound();
  const teachingTeam = isActiveTeachingMember(membership);
  const staff = user.isAdmin || membership?.role === 'TEACHER' || membership?.role === 'TA';
  const group = await db.group.findFirst({ where: { id: groupId, offeringId }, include: { page: true, members: { where: staff ? {} : { leftAt: null, courseMember: { status: 'ACTIVE' } }, orderBy: { joinedAt: 'asc' }, include: { courseMember: { include: { user: true } } } }, taAssignments: { where: { endedAt: null, courseMember: { status: 'ACTIVE' } }, include: { courseMember: { include: { user: true } } } } } });
  if (!group) notFound();
  const { source, lessonRecords, lessonReturn, memberReturn, params: origin } = await getGroupWorkOrigin(user, membership, offeringId, groupId, returnTo);
  const editable = own || user.isAdmin;
  const archived = offering.status === 'ARCHIVED';
  const ownStudent = own && !user.isAdmin && membership?.role === 'STUDENT';
  const formation = ownStudent ? getGroupFormationWindow(offering) : null;
  const base = `/courses/${encodeURIComponent(offeringId)}`;
  const projectTitle = group.page?.title && group.page.title !== group.name ? group.page.title : null;
  const body = group.page?.body || group.description;
  const subject = { groupId };
  const [history, teaching, learning, activities] = await Promise.all([
    getGroupPageHistory(user.id, offeringId, groupId),
    teachingTeam ? getTeachingHistory(user.id, offeringId, subject, { includeWithdrawn }) : null,
    ownStudent && !archived ? getStudentLearning(user.id, offeringId) : null,
    getGroupActivities(user.id, offeringId, groupId),
  ]).catch(error => { if (error instanceof DomainError) notFound(); throw error; });
  if (learning && learning.currentGroup?.id !== groupId) notFound();
  const groupTasks = learning?.currentAssignments.filter(task => task.mode === 'GROUP') ?? [];
  const pending = groupTasks.find(task => task.canSubmit && !task.currentVersion);
  const latestReceipt = groupTasks.filter(task => task.currentVersion)
    .sort((a, b) => b.currentVersion!.submittedAt.getTime() - a.currentVersion!.submittedAt.getTime())[0];
  const otherUnsubmitted = offering.status === 'DRAFT' ? groupTasks.find(task => !task.currentVersion) : groupTasks.findLast(task => !task.currentVersion);
  const featured = pending ?? otherUnsubmitted ?? latestReceipt;
  const groupOrigin = new URLSearchParams({ fromGroup: groupId });
  if (source) groupOrigin.set('fromPage', source.id);
  if (lessonRecords) groupOrigin.set('fromLessonRecords', '1');
  const readingOrigin = new URLSearchParams(groupOrigin);
  if (memberReturn) {
    readingOrigin.set('fromGroupMember', memberReturn.id);
    const priorGroup = origin.get('fromGroup');
    if (priorGroup) readingOrigin.set('fromGroupMemberPriorGroup', priorGroup);
    if (origin.has('fromRecords')) readingOrigin.set('fromRecords', '1');
    if (origin.has('fromRecordsMember')) readingOrigin.set('fromRecordsMember', '1');
    const memberSearch = origin.get('fromMemberSearch');
    if (memberSearch) readingOrigin.set('fromMemberSearch', memberSearch);
  }
  const featuredHref = featured && `${base}/assignments/${encodeURIComponent(featured.id)}${featured.currentVersion
    ? `/submissions/${encodeURIComponent(featured.currentVersion.id)}` : ''}?${groupOrigin}`;
  const memberOrigin = new URLSearchParams(groupOrigin);
  setLessonRecordOrigin(memberOrigin, lessonRecords);
  const memberHref = (memberId: string) => `${base}/members/${encodeURIComponent(memberId)}?${memberOrigin}`;
  const currentMembers = group.members.filter(member => !member.leftAt && member.courseMember.status === 'ACTIVE');
  const activityMembers = own && membership?.status === 'ACTIVE' && membership.role === 'STUDENT' && offering.status === 'ACTIVE'
    ? currentMembers.filter(member => member.courseMember.role === 'STUDENT').map(member => ({
      id: member.courseMemberId, name: member.courseMember.user.name,
    }))
    : null;
  const activitySection = <GroupActivities activities={activities}
    members={activityMembers} scope={{ viewerId: user.id, offeringId, groupId }}/>;
  const showcaseHref = showcaseWorkspaceHref(offeringId, groupId, origin, teachingTeam);
  const showcaseLink = teachingTeam || (membership?.role === 'STUDENT' && membership.status === 'ACTIVE' && own)
    ? <Link href={showcaseHref} prefetch={false}>{teachingTeam ? '查看与确认展示' : offering.status === 'ACTIVE' ? '整理展示' : '小组展示'} →</Link>
    : null;
  const team = <aside className={styles.team}><h2>小组团队</h2><section><h3>当前组员</h3>{currentMembers.length ? <ul>{currentMembers.map(m => <li key={m.id}>{m.courseMember.user.name}</li>)}</ul> : <p className={styles.empty}>待分配</p>}</section><section><h3>负责助教</h3>{group.taAssignments.length ? <ul>{group.taAssignments.map(a => <li key={a.id}>{a.courseMember.user.name}</li>)}</ul> : <p className={styles.empty}>待分配</p>}</section></aside>;
  const back = memberReturn ?? lessonReturn ?? (staff ? { href: groupWorkHref(offeringId), label: '小组' } : null);
  const breadcrumbs = back && <div className="inline-actions"><Link className="breadcrumb" href={back.href}>← {back.label}</Link></div>;
  const editor = <GroupPageEditor key={JSON.stringify([user.id, offeringId, groupId])} viewerId={user.id} offeringId={offeringId} groupId={groupId} canEdit={editable && !archived} archived={archived} history={history} initial={{
    title: group.page?.title || group.name, body, revision: group.page?.revision ?? 0, updatedAt: group.page?.updatedAt.toISOString() ?? null,
  }}/>;
  const membershipRows = teaching ? group.members.filter(member => member.leftAt || member.courseMember.status === 'INACTIVE') : group.members;
  const memberHistory = staff && membershipRows.length > 0 && <details className={styles.history}>
    <summary>组员变化记录</summary>
    <div className="table-scroll"><table className="data-table">
      <thead><tr><th>姓名</th><th>加入时间</th><th>离组时间</th></tr></thead>
      <tbody>{membershipRows.map(m => <tr key={m.id}>
        <td>{teachingTeam ? <Link href={memberHref(m.courseMemberId)}>{m.courseMember.user.name}</Link> : m.courseMember.user.name}</td>
        <td>{displayDate(m.joinedAt)}</td>
        <td>{m.leftAt ? displayDate(m.leftAt) : m.courseMember.status === 'INACTIVE' ? '成员已停用' : archived ? '归档时在组' : '当前组员'}</td>
      </tr>)}</tbody>
    </table></div>
  </details>;

  const frame = { user, offering, membership, active: 'groups' as const, groupSourcePageId: source?.id, groupSourceLessonRecords: lessonRecords };
  if (teaching) return <CourseFrame {...frame}>
    <div className={readingStyles.reading}>
      {breadcrumbs}
      <header className={readingStyles.readingHeader}>
        <h1>{group.name}{projectTitle && <> <span className={readingStyles.titleGroup}>· {projectTitle}</span></>}</h1>
        {currentMembers.length > 0 && <p className={readingStyles.meta}>
          {archived ? '归档时组员' : '组员'} {currentMembers.map((member, index) => <span key={member.id}>
            {index > 0 && '、'}<Link href={memberHref(member.courseMemberId)} prefetch={false}>{member.courseMember.user.name}</Link>
          </span>)}
        </p>}
        {group.taAssignments.length > 0 && <p className={readingStyles.meta}>助教 {group.taAssignments.map(assignment => assignment.courseMember.user.name).join('、')}</p>}
        {archived && <p className={readingStyles.meta}>课程已归档</p>}
        {showcaseLink && <div className="inline-actions">{showcaseLink}</div>}
        <TeachingObservationForm offeringId={offeringId} authorId={user.id} subject={subject} subjectName={group.name}
          archived={archived} simpleNote summaryLabel="记小组备注"/>
        <TeachingObservationForm offeringId={offeringId} authorId={user.id} subject={subject} subjectName={group.name}
          archived={archived} draftOnly sourcePageId={source?.id} sourcePageTitle={source?.title}/>
      </header>
      {body.trim() && <section className={readingStyles.work} id="group-work"><h2>小组工作</h2><p className={readingStyles.body}>{body}</p></section>}
      {activitySection}
      {editor}
      {includeWithdrawn && <p className={readingStyles.meta}>含已撤回的记录 · <Link href={currentHref}>返回现有记录</Link></p>}
      <TeachingObservationPanel offeringId={offeringId} authorId={user.id} subject={subject} name={group.name} history={teaching}
        origin={readingOrigin} archived={archived} showEmpty={!body.trim() && !activities.length} sourcePageId={source?.id} sourcePageTitle={source?.title}
        withdrawnHistoryHref={withdrawnHref}/>
      {memberHistory}
    </div>
  </CourseFrame>;
  return <CourseFrame {...frame}><div className={styles.space}>
    <header className={styles.heading}>
      {breadcrumbs}
      <div className={styles.titleRow}><div>{projectTitle && <p className={styles.groupIdentity}>{group.name}</p>}<h1>{projectTitle || group.name}</h1></div>{showcaseLink}</div>
    </header>
    {archived && <p className={styles.archive}>本学期已归档，小组主页保持只读。</p>}
    <div className={styles.workspace}>
      <div className={styles.workArea}>
        <section className={styles.records} id="group-work">
          <h2>当前工作</h2>
          {body.trim() ? <div className={styles.recordBody}>{body.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
            : <p className={styles.empty}>尚未填写项目的当前方案和下一步。</p>}
        </section>
        {activitySection}
        {learning && <section className={styles.groupAssignment} aria-labelledby="group-assignment-title">
          <h2 id="group-assignment-title">本组作业</h2>
          {featured && featuredHref ? <>
            <p><Link href={featuredHref}>{featured.title} →</Link></p>
            {featured.currentVersion ? <p className={styles.empty}>本组已交 · {featured.currentVersion.submittedByName}提交 · <time dateTime={featured.currentVersion.submittedAt.toISOString()}>{formatTeachingDate(featured.currentVersion.submittedAt)}</time></p>
              : <p className={styles.empty}>{featured.canSubmit ? '待交' : featured.blockedReason}{featured.dueAt && <> · 截止 <time dateTime={featured.dueAt.toISOString()}>{formatTeachingDate(featured.dueAt)}</time></>}</p>}
          </> : <p className={styles.empty}>暂无已发布的小组作业。<Link href={base}>查看课程首页 →</Link></p>}
        </section>}
        {editor}
      </div>
      {team}
      {formation && group.recruitmentMode && <GroupRecruitment offeringId={offeringId} expectedUserId={user.id} groupId={groupId} window={formation}
        remaining={Math.max(0, formation.capacity - group.members.filter(member => member.courseMember.role === 'STUDENT').length)}
        recruitment={{ mode: group.recruitmentMode, windowId: group.recruitmentWindowId, token: group.recruitmentToken, note: group.recruitmentNote }}/>}
      {ownStudent && !archived && <p className={styles.empty}>如需调组，请<Link href={`${base}/team`}>联系课程教师</Link>。</p>}
      {memberHistory}
    </div>
  </div></CourseFrame>;
}
