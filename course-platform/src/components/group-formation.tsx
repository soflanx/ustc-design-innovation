import { randomUUID } from 'node:crypto';
import { closeGroupFormationAction, createStudentGroupAction, joinStudentGroupAction, saveGroupFormationAction, updateGroupRecruitmentAction } from '@/lib/group-formation-actions';
import { groupWorkHref } from '@/lib/group-work-link';
import { formatTeachingDate, toTeachingDateInput } from '@/lib/teaching-format';
import { ActionForm } from './action-form';
import { GroupFormationWindowFields, GroupInvitationLink, GroupRecruitmentFields } from './group-formation-fields';
import styles from './group-formation.module.css';

type FormationWindow = { id: string; capacity: number; closesAt: Date };
type FormationContext = { offeringId: string; expectedUserId: string; sourcePageId?: string };
type Recruit = { id: string; name: string; note: string | null; remaining: number };
type RecruitmentMode = 'COURSE' | 'INVITE' | 'CLOSED';

export function GroupFormationSettings({ offeringId, expectedUserId, window, capacity, closesAt, archived }: FormationContext & {
  window: FormationWindow | null;
  capacity: number | null;
  closesAt: Date | null;
  archived: boolean;
}) {
  const deadline = toTeachingDateInput(window?.closesAt ?? null);
  const settingsForm = <ActionForm action={saveGroupFormationAction.bind(null, offeringId, expectedUserId, window?.id ?? null)} submitLabel={window ? '保存组队设置' : '开放自助组队'} className={styles.form}>
    <GroupFormationWindowFields key={`${expectedUserId}:${capacity}:${deadline}`} initialCapacity={capacity?.toString() ?? ''} initialDeadline={deadline}/>
  </ActionForm>;
  return <section className={styles.section} aria-labelledby="group-formation-settings-title">
    <h2 id="group-formation-settings-title">学生自助组队</h2>
    {archived ? <p className={styles.note}>本学期已归档，组队设置只读。</p> : window ? <>
      <p className={styles.note}><strong>组队开放中</strong> · 每组最多 {window.capacity} 人 · <time dateTime={window.closesAt.toISOString()}>{formatTeachingDate(window.closesAt)}</time>截止</p>
      <details className={styles.disclosure}>
        <summary>调整组队设置</summary>
        {settingsForm}
      </details>
      <details className={styles.disclosure}>
        <summary>结束自助组队</summary>
        <ActionForm action={closeGroupFormationAction.bind(null, offeringId, expectedUserId, window.id)} submitLabel="确认结束自助组队" className={styles.form}>
          <p className={styles.note}>结束后，本期的招募和邀请链接停止接受加入。</p>
        </ActionForm>
      </details>
    </> : <>
      <p className={styles.note}>{closesAt ? '本期自助组队已结束。' : '本期尚未开放自助组队。'}</p>
      <p className={styles.note}>开放后，本期未分组学生可以自行建立或加入正式小组。学生入组后由课程教师办理调组。</p>
      {settingsForm}
    </>}
  </section>;
}

export function JoinStudentGroupForm({ offeringId, expectedUserId, sourcePageId, windowId, target }: FormationContext & {
  windowId: string;
  target: { groupId: string } | { inviteToken: string };
}) {
  return <ActionForm action={joinStudentGroupAction.bind(null, offeringId, expectedUserId, windowId, randomUUID(), target, sourcePageId)}
    submitLabel="确认加入" className={styles.joinForm}>{null}</ActionForm>;
}

export function StudentGroupFormation({ offeringId, expectedUserId, sourcePageId, window, groups }: FormationContext & {
  window: FormationWindow;
  groups: Recruit[];
}) {
  return <section className={`${styles.section} ${styles.recruiting}`} aria-labelledby="recruiting-groups-title">
    <div>
      <h2 id="recruiting-groups-title">正在招募的小组</h2>
      <p className={styles.note}>你尚未分组。每组最多 {window.capacity} 人，组队开放至 <time dateTime={window.closesAt.toISOString()}>{formatTeachingDate(window.closesAt)}</time>。</p>
      <p className={styles.note}>收到同学的邀请时，可打开链接确认加入。</p>
      {!groups.length && <p className={styles.note}>目前没有公开招募的小组。</p>}
    </div>
    <details className={styles.createGroup}>
      <summary>建立小组</summary>
      <p className={styles.note}>建组后，你将成为这个小组的正式成员。需要调组时，请联系课程教师。</p>
      <ActionForm action={createStudentGroupAction.bind(null, offeringId, expectedUserId, window.id, randomUUID(), sourcePageId)}
        submitLabel="建立小组" className={styles.form}>
        <GroupRecruitmentFields key={`${expectedUserId}:${window.id}`} creating/>
      </ActionForm>
    </details>
    {groups.length > 0 && <ul className={styles.recruitList}>{groups.map(group => <li key={group.id}>
      <div>
        <h3>{group.name}</h3>
        <p className={styles.note}>还可加入 {group.remaining} 人</p>
        {group.note && <p className={styles.description}>{group.note}</p>}
      </div>
      <JoinStudentGroupForm offeringId={offeringId} expectedUserId={expectedUserId} windowId={window.id} sourcePageId={sourcePageId} target={{ groupId: group.id }}/>
    </li>)}</ul>}
  </section>;
}

export function GroupRecruitment({ offeringId, expectedUserId, groupId, window, remaining, recruitment }: FormationContext & {
  groupId: string;
  window: FormationWindow;
  remaining: number;
  recruitment: { mode: RecruitmentMode; windowId: string | null; token: string | null; note: string | null };
}) {
  const mode = recruitment.windowId === window.id ? recruitment.mode : 'CLOSED';
  const invitationPath = mode === 'INVITE' && recruitment.token && remaining > 0
    ? `${groupWorkHref(offeringId)}/join/${encodeURIComponent(recruitment.token)}` : null;
  const status = mode === 'COURSE' ? '本班公开招募' : mode === 'INVITE' ? '仅邀请链接' : '招募已停止';
  return <section className={styles.section} aria-labelledby="group-recruitment-title">
    <h2 id="group-recruitment-title">本组招募</h2>
    <p className={styles.note}>{status} · {remaining > 0 ? `还有 ${remaining} 个名额` : '本组已满'}</p>
    {invitationPath && <GroupInvitationLink key={invitationPath} path={invitationPath}/>}
    <details className={styles.disclosure}>
      <summary>调整招募设置</summary>
      <ActionForm action={updateGroupRecruitmentAction.bind(null, offeringId, expectedUserId, groupId, window.id)}
        submitLabel="保存招募设置" className={styles.form}>
        <GroupRecruitmentFields key={JSON.stringify([expectedUserId, window.id, mode, recruitment.note])} initialMode={mode} initialNote={recruitment.note ?? ''}/>
      </ActionForm>
    </details>
  </section>;
}
