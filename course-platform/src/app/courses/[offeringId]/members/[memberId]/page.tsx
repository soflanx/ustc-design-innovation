import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CourseFrame } from '@/components/course-frame';
import { TeachingObservationPanel } from '@/components/teaching-observation-panel';
import { TeachingObservationForm } from '@/components/teaching-observation-form';
import styles from '@/components/teaching-history.module.css';
import { requireOfferingAccess } from '@/lib/access';
import { getGroupActivitySource } from '@/lib/course-subpages';
import { courseLessonHref, groupWorkHref, parseGroupSource } from '@/lib/group-work-link';
import { DomainError } from '@/lib/management';
import { displayDate } from '@/lib/policy';
import { getTeachingHistory, teachingMemberSearch } from '@/lib/teaching-history';

export default async function MemberTeachingPage({ params, searchParams }: {
  params: Promise<{ offeringId: string; memberId: string }>;
  searchParams: Promise<{
    fromPage?: string | string[]; fromGroup?: string | string[]; fromRecords?: string | string[];
    fromRecordsMember?: string | string[]; fromLessonRecords?: string | string[]; q?: string | string[];
    includeWithdrawn?: string | string[];
  }>;
}) {
  const { offeringId, memberId } = await params;
  const query = await searchParams;
  const requestedPage = parseGroupSource(query.fromPage);
  const requestedGroup = parseGroupSource(query.fromGroup);
  const fromRecords = query.fromRecords === '1';
  const fromRecordsMember = fromRecords && query.fromRecordsMember === '1';
  const fromLessonRecords = Boolean(requestedPage && query.fromLessonRecords === '1');
  const includeWithdrawn = query.includeWithdrawn === '1';
  const search = teachingMemberSearch(query.q);
  const base = `/courses/${encodeURIComponent(offeringId)}`;
  const route = `${base}/members/${encodeURIComponent(memberId)}`;
  const returnTo = new URLSearchParams();
  if (requestedPage) returnTo.set('fromPage', requestedPage);
  if (requestedGroup) returnTo.set('fromGroup', requestedGroup);
  if (fromRecords) returnTo.set('fromRecords', '1');
  if (fromRecordsMember) returnTo.set('fromRecordsMember', '1');
  if (fromLessonRecords) returnTo.set('fromLessonRecords', '1');
  if (search) returnTo.set('q', search);
  const withdrawnQuery = new URLSearchParams(returnTo);
  withdrawnQuery.set('includeWithdrawn', '1');
  const currentHref = returnTo.size ? `${route}?${returnTo}` : route;
  const withdrawnHref = `${route}?${withdrawnQuery}`;
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, includeWithdrawn ? withdrawnHref : currentHref);
  if (membership?.status !== 'ACTIVE' || (membership.role !== 'TEACHER' && membership.role !== 'TA')) notFound();

  const subject = { memberId };
  let history;
  try { history = await getTeachingHistory(user.id, offeringId, subject, { includeWithdrawn }); }
  catch (error) { if (error instanceof DomainError) notFound(); throw error; }
  const { member } = history;
  if (!member) notFound();
  const source = await getGroupActivitySource(user, offeringId, requestedPage, membership.role);
  const lessonRecords = Boolean(source && fromLessonRecords);
  const priorGroup = member.groupMemberships.find(item => item.group.id === requestedGroup)?.group;
  const currentGroup = member.status === 'ACTIVE' ? member.groupMemberships.find(item => !item.leftAt)?.group : undefined;
  const formerMemberships = member.groupMemberships.filter(item => item.leftAt);
  const archived = offering.status === 'ARCHIVED';
  const recordsQuery = new URLSearchParams();
  if (source) recordsQuery.set('fromPage', source.id);
  if (fromRecordsMember) recordsQuery.set('memberId', memberId);
  const recordsHref = `${base}/records${recordsQuery.size ? `?${recordsQuery}` : ''}`;
  const membersHref = `${base}/members${search ? `?${new URLSearchParams({ q: search })}` : ''}`;
  const origin = new URLSearchParams({ fromMember: member.id });
  if (source) origin.set('fromPage', source.id);
  if (lessonRecords) origin.set('fromLessonRecords', '1');
  if (priorGroup) origin.set('fromGroup', priorGroup.id);
  if (fromRecords) origin.set('fromRecords', '1');
  if (fromRecordsMember) origin.set('fromRecordsMember', '1');
  if (search) origin.set('fromMemberSearch', search);
  const groupHref = (groupId: string) => `${groupWorkHref(offeringId, undefined, groupId)}?${origin}`;
  const priorGroupQuery = new URLSearchParams();
  if (source) priorGroupQuery.set('fromPage', source.id);
  if (lessonRecords) priorGroupQuery.set('fromLessonRecords', '1');
  const priorGroupHref = priorGroup && `${groupWorkHref(offeringId, undefined, priorGroup.id)}${priorGroupQuery.size ? `?${priorGroupQuery}` : ''}`;

  return <CourseFrame user={user} offering={offering} membership={membership} active="members" groupSourcePageId={source?.id}>
    <div className={styles.reading}>
      <div className="inline-actions">
        {fromRecords && <Link className="breadcrumb" href={recordsHref}>← 返回课堂记录</Link>}
        {priorGroup && priorGroupHref && <Link className="breadcrumb" href={priorGroupHref}>← {priorGroup.name}</Link>}
        {!fromRecords && !priorGroup && !lessonRecords && <Link className="breadcrumb" href={membersHref}>← 学生</Link>}
        {source && <Link className="breadcrumb" href={courseLessonHref(offeringId, source.id, lessonRecords)}>← 返回《{source.title}》{lessonRecords && '记录'}</Link>}
        {search && (fromRecords || priorGroup || lessonRecords) && <Link className="breadcrumb" href={membersHref}>学生</Link>}
      </div>
      <header className={styles.readingHeader}>
        <h1>{member.user.name}{currentGroup
          ? <> <span className={styles.titleGroup}>· <Link href={groupHref(currentGroup.id)} prefetch={false}>{currentGroup.name}</Link></span></>
          : member.status === 'ACTIVE' && <> <span className={styles.titleGroup}>· 未分组</span></>}</h1>
        {(archived || member.status === 'INACTIVE') && <p className={styles.meta}>
          {member.status === 'INACTIVE' ? '本期成员已停用' : '课程已归档'}
        </p>}
        {formerMemberships.length > 0 && <p className={styles.meta}>
          曾在 {formerMemberships.map((entry, index) => <span key={entry.id}>
            {index > 0 && '、'}<Link href={groupHref(entry.group.id)} prefetch={false}>{entry.group.name}</Link>
            {entry.leftAt && <> <span className={styles.dates}>（{displayDate(entry.joinedAt)}至{displayDate(entry.leftAt)}）</span></>}
          </span>)}
        </p>}
        <TeachingObservationForm offeringId={offeringId} authorId={user.id} subject={subject} subjectName={member.user.name}
          archived={archived} simpleNote summaryLabel="记个人备注"/>
        <TeachingObservationForm offeringId={offeringId} authorId={user.id} subject={subject} subjectName={member.user.name}
          archived={archived} draftOnly sourcePageId={source?.id} sourcePageTitle={source?.title}
          sourceGroupId={priorGroup?.id} sourceGroupName={priorGroup?.name}/>
      </header>
      {includeWithdrawn && <p className={styles.meta}>含已撤回的记录 · <Link href={currentHref}>返回现有记录</Link></p>}
      <TeachingObservationPanel offeringId={offeringId} authorId={user.id} subject={subject} name={member.user.name}
        history={history} origin={origin} archived={archived} sourcePageId={source?.id} sourcePageTitle={source?.title}
        sourceGroupId={priorGroup?.id} sourceGroupName={priorGroup?.name} withdrawnHistoryHref={withdrawnHref}/>
    </div>
  </CourseFrame>;
}
