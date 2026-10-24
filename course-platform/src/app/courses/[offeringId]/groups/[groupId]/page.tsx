import Link from 'next/link';
import styles from '@/app/group-space.module.css';
import { notFound } from 'next/navigation';
import { requireOfferingAccess } from '@/lib/access';
import { db } from '@/lib/db';
import { canViewGroup, displayDate } from '@/lib/policy';
import { saveGroupPageAction } from '@/lib/actions';
import { CourseFrame } from '@/components/course-frame';
import { ActionForm } from '@/components/action-form';

export default async function GroupPage({ params }: { params: Promise<{ offeringId: string; groupId: string }> }) {
  const { offeringId, groupId } = await params;
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, `/courses/${offeringId}/groups/${groupId}`);
  const own = membership ? !!await db.groupMember.findFirst({ where: { offeringId, groupId, courseMemberId: membership.id, leftAt: null } }) : false;
  if (!canViewGroup(user.isAdmin, membership, own)) notFound();
  const staff = user.isAdmin || membership?.role === 'TEACHER' || membership?.role === 'TA';
  const group = await db.group.findFirst({ where: { id: groupId, offeringId }, include: { page: true, members: { where: staff ? {} : { leftAt: null, courseMember: { status: 'ACTIVE' } }, orderBy: { joinedAt: 'asc' }, include: { courseMember: { include: { user: true } } } }, taAssignments: { where: { endedAt: null, courseMember: { status: 'ACTIVE' } }, include: { courseMember: { include: { user: true } } } } } });
  if (!group) notFound();
  const editable = own || user.isAdmin;
  const archived = offering.status === 'ARCHIVED';
  const projectTitle = group.page?.title && group.page.title !== group.name ? group.page.title : null;
  const body = group.page?.body || group.description;
  return <CourseFrame user={user} offering={offering} membership={membership} active="groups"><div className={styles.space}><header className={styles.heading}>{staff && <Link className="breadcrumb" href={`/courses/${offeringId}/groups`}>← 小组</Link>}<div className={styles.titleRow}><div>{projectTitle && <p className={styles.groupIdentity}>{group.name}</p>}<h1>{projectTitle || group.name}</h1></div></div></header>{archived && <p className={styles.archive}>本学期已归档，小组主页保持只读。</p>}<div className={styles.workspace}><div><section className={styles.records}><h2>工作记录</h2>{body ? <div className={styles.recordBody}>{body.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div> : <p className={styles.empty}>本组尚未填写工作记录。</p>}</section>{editable && !archived && <details className={styles.editor}><summary>编辑项目标题与工作记录</summary><div className={styles.editorForm}><ActionForm action={saveGroupPageAction.bind(null, offeringId, groupId)} submitLabel="保存记录"><div className="form-field"><label htmlFor="page-title">项目标题</label><input id="page-title" name="title" maxLength={100} required defaultValue={group.page?.title || group.name}/></div><div className="form-field"><label htmlFor="page-body">工作记录</label><textarea id="page-body" name="body" rows={12} maxLength={12000} required defaultValue={group.page?.body || group.description}/><p className="field-help">本组成员与教学团队可查看。</p></div></ActionForm></div></details>}{staff && <details className={styles.history}><summary>组员变化记录</summary><div className="table-scroll"><table className="data-table"><thead><tr><th>姓名</th><th>加入时间</th><th>离组时间</th></tr></thead><tbody>{group.members.map(m => <tr key={m.id}><td>{m.courseMember.user.name}</td><td>{displayDate(m.joinedAt)}</td><td>{m.leftAt ? displayDate(m.leftAt) : '当前组员'}</td></tr>)}</tbody></table></div>{!group.members.length && <p className={styles.empty}>尚无组员记录。</p>}</details>}</div><aside className={styles.team}><h2>小组团队</h2><section><h3>当前组员</h3>{group.members.filter(m => !m.leftAt && m.courseMember.status === 'ACTIVE').length ? <ul>{group.members.filter(m => !m.leftAt && m.courseMember.status === 'ACTIVE').map(m => <li key={m.id}>{m.courseMember.user.name}</li>)}</ul> : <p className={styles.empty}>待分配</p>}</section><section><h3>负责助教</h3>{group.taAssignments.length ? <ul>{group.taAssignments.map(a => <li key={a.id}>{a.courseMember.user.name}</li>)}</ul> : <p className={styles.empty}>待分配</p>}</section></aside></div></div></CourseFrame>;
}
