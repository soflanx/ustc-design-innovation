import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CourseFrame } from '@/components/course-frame';
import styles from '@/components/teaching-history.module.css';
import { requireOfferingAccess } from '@/lib/access';
import { DomainError } from '@/lib/management';
import { listTeachingMembers, teachingMemberSearch, teachingMemberSearchLimit } from '@/lib/teaching-history';

export default async function TeachingMembersPage({ params, searchParams }: {
  params: Promise<{ offeringId: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { offeringId } = await params;
  const search = teachingMemberSearch((await searchParams).q);
  const base = `/courses/${encodeURIComponent(offeringId)}`;
  const route = `${base}/members`;
  const suffix = search ? `?${new URLSearchParams({ q: search })}` : '';
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, `${route}${suffix}`);
  if (membership?.status !== 'ACTIVE' || (membership.role !== 'TEACHER' && membership.role !== 'TA')) notFound();
  let members;
  try { members = await listTeachingMembers(user.id, offeringId, search); }
  catch (error) { if (error instanceof DomainError) notFound(); throw error; }

  return <CourseFrame user={user} offering={offering} membership={membership} active="members">
    <div className={styles.directory}>
      <header>
        <Link className="breadcrumb" href={base}>← 课程首页</Link>
        <h1>学生</h1>
        {offering.status === 'ARCHIVED' && <p className={styles.meta}>本期已归档，可继续回看学习记录。</p>}
      </header>
      <form className={styles.search} action={route} method="get" key={search}>
        <div className="form-field">
          <label htmlFor="member-search">按姓名查找学生</label>
          <input id="member-search" name="q" type="search" defaultValue={search} maxLength={teachingMemberSearchLimit}/>
        </div>
        <button className="button" type="submit">查找</button>
        {search && <Link href={route}>清除</Link>}
      </form>
      {members.length ? <ul className={styles.entries}>{members.map(member => <li key={member.id} className={styles.directoryEntry}>
        <Link href={`${route}/${encodeURIComponent(member.id)}${suffix}`} prefetch={false}>{member.user.name}</Link>
        <span className={styles.meta}>{member.status === 'INACTIVE' ? '已停用' : member.groupMemberships[0]?.group.name ?? '未分组'}</span>
      </li>)}</ul> : <p className={styles.meta}>{search ? '没有找到这个姓名。' : '本期暂无学生。'}</p>}
    </div>
  </CourseFrame>;
}
