import Link from 'next/link';
import type { CourseMember, Prisma } from '@prisma/client';
import { getAssignmentIndex } from '@/lib/teaching';
import { getCourseResources } from '@/lib/resource-service';
import { getCourseFocus } from '@/lib/course-focus';
import { formatTeachingDate } from '@/lib/teaching-format';
import { getAssignmentHomeItems } from '@/lib/teaching-presentation';
import { CourseFrame } from './course-frame';
import { CourseFocusEditor } from './course-focus-editor';
import type { SiteUser } from './site-shell';
import styles from './current-teaching.module.css';

type Offering = Prisma.CourseOfferingGetPayload<{ include: { course: true; term: true } }>;

export async function CourseWorkspace({ offering, user, membership }: {
  offering: Offering;
  user: SiteUser & { id: string; isAdmin: boolean };
  membership: CourseMember | null;
}) {
  const student = !user.isAdmin && membership?.role === 'STUDENT';
  const ta = !user.isAdmin && membership?.role === 'TA';
  const archived = offering.status === 'ARCHIVED';
  const basePath = `/courses/${offering.id}`;
  const [teaching, materials, focusData] = await Promise.all([
    getAssignmentIndex(user.id, offering.id),
    getCourseResources(user.id, offering.id),
    getCourseFocus(user.id, offering.id),
  ]);
  const { focus, canEdit } = focusData;
  const selectedTasks = new Set(focus?.assignmentIds ?? []);
  const selectedResources = new Set(focus?.resourceIds ?? []);
  const assignments = getAssignmentHomeItems(teaching.assignments.filter(assignment => selectedTasks.has(assignment.id)), {
    audience: user.isAdmin ? 'ADMIN' : membership!.role,
    offeringStatus: offering.status,
  });
  const resources = materials.resources.filter(resource => selectedResources.has(resource.id));
  const primaryTask = assignments.find(assignment => assignment.home.actionable)?.id;

  return <CourseFrame user={user} offering={offering} membership={membership} active="overview"><div className={styles.page} data-workspace-role={user.isAdmin ? 'ADMIN' : membership?.role}>
    {archived && <p className={styles.notice}>本学期已归档，教学内容、提交和反馈保持只读。</p>}
    {offering.status === 'DRAFT' && <p className={styles.notice}>课程筹备中，暂不接受学生提交。</p>}
      <div className={styles.content}>
        <section className={styles.brief} aria-label="当前教学内容" data-course-focus={focus ? 'set' : 'empty'}>
          {focus ? <><h1>{focus.title}</h1>{focus.body && <p className={styles.briefBody}>{focus.body}</p>}</> : <><h1>{canEdit ? '填写当前教学内容' : archived ? '未保留教学内容说明' : '当前教学内容待发布'}</h1><p className={styles.emptyDescription}>{canEdit ? '这里是学生进入课程后首先看到的内容。写清现在在做什么、要完成什么，再选择相关任务和资料。' : archived ? '该学期没有保存教学内容说明，可查看作业、反馈和小组记录。' : '教学团队尚未填写当前安排，你仍可查看已发布的作业与课程资料。'}</p>{!canEdit && <Link className={styles.emptyAction} href={`${basePath}/assignments`}>查看作业与反馈 →</Link>}</>}
          {canEdit && <CourseFocusEditor offeringId={offering.id} focus={focus} assignments={teaching.assignments.map(({ id, title, status }) => ({ id, title, status }))} resources={materials.resources.map(({ id, title, status }) => ({ id, title, status }))}/>}
        </section>
        {!!assignments.length && <section className={styles.taskSection} aria-labelledby="current-tasks-heading">
          <div className={styles.sectionHeading}><h2 id="current-tasks-heading">{student ? '本次任务' : user.isAdmin ? '关联任务' : '本次任务与提交'}</h2></div>
          {ta && <p className={styles.scopeNote}>提交与待反馈按你负责的小组统计。</p>}
          <div className={styles.taskList}>{assignments.map(assignment => <article className={styles.task} key={assignment.id} data-current-task={assignment.id}>
            <div><h3>{assignment.title}</h3>
              <div className={styles.taskFacts}><span>{assignment.mode === 'GROUP' ? '小组提交' : '个人提交'}</span>{assignment.dueAt && <time dateTime={assignment.dueAt.toISOString()}>截止：{formatTeachingDate(assignment.dueAt)}</time>}{assignment.status !== 'PUBLISHED' && <span>{assignment.status === 'DRAFT' ? '草稿 · 学生不可见' : '作业已结束'}</span>}</div>
            </div>
            <div className={styles.taskAction} data-assignment-scope={ta ? 'mine' : student ? 'self' : 'all'}><p>{assignment.home.statusLabel}</p><Link className={assignment.id === primaryTask ? styles.primaryAction : styles.textAction} href={assignment.home.href}>{assignment.home.actionLabel} →</Link>{ta && <Link className={styles.allScope} href={`${basePath}/assignments/${assignment.id}?view=latest&scope=all`}>查看全班</Link>}</div>
          </article>)}</div>
        </section>}
        {!!resources.length && <section className={styles.resourceSection} aria-labelledby="current-resources-heading"><h2 id="current-resources-heading">本次资料</h2><ul>{resources.map(resource => <li key={resource.id}><Link href={`${basePath}/resources/${resource.id}`}>{resource.title}</Link>{resource.status !== 'PUBLISHED' && <span>{resource.status === 'DRAFT' ? '草稿 · 学生不可见' : '已下架 · 学生不可见'}</span>}</li>)}</ul></section>}
      </div>
  </div></CourseFrame>;
}
