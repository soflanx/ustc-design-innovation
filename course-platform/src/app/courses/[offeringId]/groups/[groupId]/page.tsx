import Link from 'next/link';
import styles from '@/app/group-space.module.css';
import { notFound } from 'next/navigation';
import { requireOfferingAccess } from '@/lib/access';
import { db } from '@/lib/db';
import { canViewGroup, displayDate } from '@/lib/policy';
import { DomainError, getGroupPageHistory } from '@/lib/management';
import { CourseFrame } from '@/components/course-frame';
import { GroupRecruitment } from '@/components/group-formation';
import { GroupPageEditor } from '@/components/group-page-editor';
import { TeachingObservationPanel } from '@/components/teaching-observation-panel';
import { TeachingObservationForm } from '@/components/teaching-observation-form';
import readingStyles from '@/components/teaching-history.module.css';
import { getTeachingHistory, teachingMemberSearch } from '@/lib/teaching-history';
import { getGroupActivitySource } from '@/lib/course-subpages';
import { getGroupFormationWindow } from '@/lib/group-formation';
import { courseLessonHref, groupWorkHref, parseGroupSource } from '@/lib/group-work-link';
import { getStudentLearning } from '@/lib/student-learning';
import { formatTeachingDate } from '@/lib/teaching-format';

export default async function GroupPage({ params, searchParams }: {
  params: Promise<{ offeringId: string; groupId: string }>;
  searchParams: Promise<{
    fromPage?: string | string[];
    fromMember?: string | string[];
    fromGroup?: string | string[];
    fromRecords?: string | string[];
    fromRecordsMember?: string | string[];
    fromLessonRecords?: string | string[];
    fromMemberSearch?: string | string[];
    includeWithdrawn?: string | string[];
  }>;
}) {
  const { offeringId, groupId } = await params;
  const query = await searchParams;
  const requestedPage = parseGroupSource(query.fromPage);
  const requestedMember = parseGroupSource(query.fromMember);
  const fromLessonRecords = Boolean(requestedPage && query.fromLessonRecords === '1');
  const memberSearch = requestedMember ? teachingMemberSearch(query.fromMemberSearch) : '';
  const includeWithdrawn = query.includeWithdrawn === '1';
  const memberOrigin = new URLSearchParams();
  if (requestedMember) {
    const priorGroup = parseGroupSource(query.fromGroup);
    if (priorGroup) memberOrigin.set('fromGroup', priorGroup);
    if (query.fromRecords === '1') {
      memberOrigin.set('fromRecords', '1');
      if (query.fromRecordsMember === '1') memberOrigin.set('fromRecordsMember', '1');
    }
  }
  const returnTo = new URLSearchParams(memberOrigin);
  if (requestedPage) returnTo.set('fromPage', requestedPage);
  if (fromLessonRecords) returnTo.set('fromLessonRecords', '1');
  if (requestedMember) returnTo.set('fromMember', requestedMember);
  if (memberSearch) returnTo.set('fromMemberSearch', memberSearch);
  const groupPath = groupWorkHref(offeringId, undefined, groupId);
  const withdrawnQuery = new URLSearchParams(returnTo);
  withdrawnQuery.set('includeWithdrawn', '1');
  const currentHref = `${groupPath}${returnTo.size ? `?${returnTo}` : ''}`;
  const withdrawnHref = `${groupPath}?${withdrawnQuery}`;
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, includeWithdrawn ? withdrawnHref : currentHref);
  const own = membership ? !!await db.groupMember.findFirst({ where: { offeringId, groupId, courseMemberId: membership.id, leftAt: null } }) : false;
  if (!canViewGroup(user.isAdmin, membership, own)) notFound();
  const teachingTeam = membership?.status === 'ACTIVE' && (membership.role === 'TEACHER' || membership.role === 'TA');
  const staff = user.isAdmin || membership?.role === 'TEACHER' || membership?.role === 'TA';
  const group = await db.group.findFirst({ where: { id: groupId, offeringId }, include: { page: true, members: { where: staff ? {} : { leftAt: null, courseMember: { status: 'ACTIVE' } }, orderBy: { joinedAt: 'asc' }, include: { courseMember: { include: { user: true } } } }, taAssignments: { where: { endedAt: null, courseMember: { status: 'ACTIVE' } }, include: { courseMember: { include: { user: true } } } } } });
  if (!group) notFound();
  const source = await getGroupActivitySource(user, offeringId, requestedPage, membership?.role);
  const lessonRecords = teachingTeam && fromLessonRecords && !!source;
  const sourceMember = teachingTeam && requestedMember
    ? group.members.find(entry => entry.courseMemberId === requestedMember && entry.courseMember.role === 'STUDENT')?.courseMember
    : undefined;
  const editable = own || user.isAdmin;
  const archived = offering.status === 'ARCHIVED';
  const ownStudent = own && !user.isAdmin && membership?.role === 'STUDENT';
  const formation = ownStudent ? getGroupFormationWindow(offering) : null;
  const base = `/courses/${encodeURIComponent(offeringId)}`;
  if (source) memberOrigin.set('fromPage', source.id);
  if (lessonRecords) memberOrigin.set('fromLessonRecords', '1');
  if (memberSearch) memberOrigin.set('q', memberSearch);
  const memberReturnHref = sourceMember
    ? `${base}/members/${encodeURIComponent(sourceMember.id)}${memberOrigin.size ? `?${memberOrigin}` : ''}`
    : null;
  const projectTitle = group.page?.title && group.page.title !== group.name ? group.page.title : null;
  const body = group.page?.body || group.description;
  const subject = { groupId };
  const [history, teaching, learning] = await Promise.all([
    getGroupPageHistory(user.id, offeringId, groupId),
    teachingTeam ? getTeachingHistory(user.id, offeringId, subject, { includeWithdrawn }) : null,
    ownStudent && !archived ? getStudentLearning(user.id, offeringId) : null,
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
  if (sourceMember) {
    readingOrigin.set('fromGroupMember', sourceMember.id);
    const priorGroup = memberOrigin.get('fromGroup');
    if (priorGroup) readingOrigin.set('fromGroupMemberPriorGroup', priorGroup);
    if (memberOrigin.has('fromRecords')) readingOrigin.set('fromRecords', '1');
    if (memberOrigin.has('fromRecordsMember')) readingOrigin.set('fromRecordsMember', '1');
    if (memberSearch) readingOrigin.set('fromMemberSearch', memberSearch);
  }
  const featuredHref = featured && `${base}/assignments/${encodeURIComponent(featured.id)}${featured.currentVersion
    ? `/submissions/${encodeURIComponent(featured.currentVersion.id)}` : ''}?${groupOrigin}`;
  const teamFirst = ownStudent && !archived;
  const memberHref = (memberId: string) => `${base}/members/${encodeURIComponent(memberId)}?${groupOrigin}`;
  const currentMembers = group.members.filter(member => !member.leftAt && member.courseMember.status === 'ACTIVE');
  const team = <aside className={styles.team}><h2>小组团队</h2><section><h3>当前组员</h3>{currentMembers.length ? <ul>{currentMembers.map(m => <li key={m.id}>{m.courseMember.user.name}</li>)}</ul> : <p className={styles.empty}>待分配</p>}</section><section><h3>负责助教</h3>{group.taAssignments.length ? <ul>{group.taAssignments.map(a => <li key={a.id}>{a.courseMember.user.name}</li>)}</ul> : <p className={styles.empty}>待分配</p>}</section></aside>;
  const breadcrumbs = (source || staff) && <div className="inline-actions">
    {sourceMember && memberReturnHref
      ? <Link className="breadcrumb" href={memberReturnHref}>← 返回{sourceMember.user.name}</Link>
      : source
        ? <Link className="breadcrumb" href={courseLessonHref(offeringId, source.id, lessonRecords)}>← 返回《{source.title}》{lessonRecords && '记录'}</Link>
        : <Link className="breadcrumb" href={groupWorkHref(offeringId)}>← 小组</Link>}
  </div>;
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

  const frame = { user, offering, membership, active: 'groups' as const, groupSourcePageId: source?.id };
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
        <TeachingObservationForm offeringId={offeringId} authorId={user.id} subject={subject} subjectName={group.name}
          archived={archived} simpleNote summaryLabel="记小组备注"/>
        <TeachingObservationForm offeringId={offeringId} authorId={user.id} subject={subject} subjectName={group.name}
          archived={archived} draftOnly sourcePageId={source?.id} sourcePageTitle={source?.title}/>
      </header>
      {body.trim() && <section className={readingStyles.work} id="group-work"><h2>小组工作</h2><p className={readingStyles.body}>{body}</p></section>}
      {editor}
      {includeWithdrawn && <p className={readingStyles.meta}>含已撤回的记录 · <Link href={currentHref}>返回现有记录</Link></p>}
      <TeachingObservationPanel offeringId={offeringId} authorId={user.id} subject={subject} name={group.name} history={teaching}
        origin={readingOrigin} archived={archived} showEmpty={!body.trim()} sourcePageId={source?.id} sourcePageTitle={source?.title}
        withdrawnHistoryHref={withdrawnHref}/>
      {memberHistory}
    </div>
  </CourseFrame>;
  return <CourseFrame {...frame}><div className={styles.space}>
    <header className={styles.heading}>
      {breadcrumbs}
      <div className={styles.titleRow}><div>{projectTitle && <p className={styles.groupIdentity}>{group.name}</p>}<h1>{projectTitle || group.name}</h1></div></div>
    </header>
    {archived && <p className={styles.archive}>本学期已归档，小组主页保持只读。</p>}
    {teamFirst && team}
    {formation && group.recruitmentMode && <GroupRecruitment offeringId={offeringId} expectedUserId={user.id} groupId={groupId} window={formation}
      remaining={Math.max(0, formation.capacity - group.members.filter(member => member.courseMember.role === 'STUDENT').length)}
      recruitment={{ mode: group.recruitmentMode, windowId: group.recruitmentWindowId, token: group.recruitmentToken, note: group.recruitmentNote }}/>}
    {learning && <section className={styles.groupAssignment} aria-labelledby="group-assignment-title">
      <h2 id="group-assignment-title">本组作业</h2>
      {featured && featuredHref ? <>
        <p><Link href={featuredHref}>{featured.title} →</Link></p>
        {featured.currentVersion ? <p className={styles.empty}>本组已交 · {featured.currentVersion.submittedByName}提交 · <time dateTime={featured.currentVersion.submittedAt.toISOString()}>{formatTeachingDate(featured.currentVersion.submittedAt)}</time></p>
          : <p className={styles.empty}>{featured.canSubmit ? '待交' : featured.blockedReason}{featured.dueAt && <> · 截止 <time dateTime={featured.dueAt.toISOString()}>{formatTeachingDate(featured.dueAt)}</time></>}</p>}
      </> : <p className={styles.empty}>暂无已发布的小组作业。<Link href={base}>查看课程首页 →</Link></p>}
    </section>}
    <div className={styles.workspace}><div>
      <section className={styles.records} id="group-work"><h2>工作记录</h2>{body ? <div className={styles.recordBody}>{body.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div> : <p className={styles.empty}>本组尚未填写工作记录。</p>}</section>
      {editor}
      {ownStudent && !archived && <p className={styles.empty}>如需调组，请<Link href={`/courses/${encodeURIComponent(offeringId)}/team`}>联系课程教师</Link>。</p>}
      {memberHistory}
    </div>{!teamFirst && team}</div>
  </div></CourseFrame>;
}
