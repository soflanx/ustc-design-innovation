import type { GroupActivityView } from '@/lib/group-activities';
import { groupWorkHref } from '@/lib/group-work-link';
import { displayDate } from '@/lib/policy';
import { formatTeachingDate, toTeachingDateInput } from '@/lib/teaching-format';
import { GroupActivityForm, GroupActivityWithdraw } from './group-activity-form';
import styles from './group-activities.module.css';

type ActivityScope = { viewerId: string; offeringId: string; groupId: string };

export function GroupActivities({ activities, members, scope }: {
  activities: GroupActivityView[];
  members: { id: string; name: string }[] | null;
  scope: ActivityScope;
}) {
  const [latest, ...earlier] = activities;
  if (!latest && members === null) return null;
  const activityPath = `${groupWorkHref(scope.offeringId, undefined, scope.groupId)}/activities`;

  function entry(activity: GroupActivityView) {
    const fileBase = `${activityPath}/${encodeURIComponent(activity.id)}/files`;
    return <article className={styles.entry} id={`activity-${activity.id}`}>
      <p className={styles.meta}>
        {activity.occurredOn && <><time dateTime={activity.occurredOn.toISOString().slice(0, 10)}>{displayDate(activity.occurredOn)}</time> 发生 · </>}
        {activity.authorName}记录于 <time dateTime={activity.createdAt.toISOString()}>{formatTeachingDate(activity.createdAt)}</time>
      </p>
      {activity.participantNames.length > 0 && <p className={styles.meta}>选填参与者 · {activity.participantNames.join('、')}</p>}
      {activity.nextStep && <p className={styles.nextStep}><strong>下一步</strong> {activity.nextStep}</p>}
      {activity.body && <p className={styles.body}>{activity.body}</p>}
      {activity.files.length > 0 && <ul className={styles.files}>
        {activity.files.map(file => <li key={file.id}>
          <a href={`${fileBase}/${encodeURIComponent(file.id)}`} target="_blank" rel="noreferrer">{file.name}</a>
        </li>)}
      </ul>}
      {members !== null && activity.authoredByViewer && <GroupActivityWithdraw {...scope} activityId={activity.id}/>}
    </article>;
  }

  return <section className={styles.section} aria-labelledby="group-activities">
    <h2 id="group-activities">过程记录</h2>
    {latest && entry(latest)}
    {earlier.length > 0 && <details className={styles.earlier}>
      <summary>以前的记录（{earlier.length}）</summary>
      <ul className={styles.entries}>{earlier.map(activity => <li key={activity.id}>{entry(activity)}</li>)}</ul>
    </details>}
    {members !== null && <GroupActivityForm key={JSON.stringify([scope.viewerId, scope.offeringId, scope.groupId])}
      {...scope} members={members} today={toTeachingDateInput(new Date()).slice(0, 10)}/>}
  </section>;
}
