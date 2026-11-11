import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { db } from '../src/lib/db';
import { DomainError, moveStudentToGroup } from '../src/lib/management';
import { createAssignment, submitAssignment } from '../src/lib/teaching';
import {
  getStudentTeachingFeedback, getTeachingObservations, getTeachingSubject,
  recordTeachingObservation, sendTeachingFeedback,
} from '../src/lib/teaching-observations';
import { confirmedSubmissionInput } from './submission-fixture';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(() => db.$disconnect());

async function fixture() {
  const key = randomUUID();
  const course = await db.course.create({ data: { slug: key, title: '观察权限审计' } });
  async function offering(label: string) {
    return db.courseOffering.create({ data: {
      course: { connect: { id: course.id } },
      term: { create: { slug: `${key}-${label}`, name: label, startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } },
      title: label, status: 'ACTIVE',
    } });
  }
  const current = await offering('本期');
  const other = await offering('另一期');
  const admin = await db.user.create({ data: { name: '站点管理员', email: `${key}-admin@test.invalid`, isAdmin: true } });
  const member = (offeringId: string, role: 'TEACHER' | 'TA' | 'STUDENT', label: string) =>
    db.courseMember.create({ data: {
      offering: { connect: { id: offeringId } }, role,
      user: { create: { name: label, email: `${key}-${label}@test.invalid` } },
    } });
  const [teacher, ta, student, otherTeacher, otherStudent] = await Promise.all([
    member(current.id, 'TEACHER', 'teacher'),
    member(current.id, 'TA', 'ta'),
    member(current.id, 'STUDENT', 'student'),
    member(other.id, 'TEACHER', 'other-teacher'),
    member(other.id, 'STUDENT', 'other-student'),
  ]);
  return { current, other, admin, teacher, ta, student, otherTeacher, otherStudent };
}

const note = (body: string, targetMemberId: string | null, targetGroupId: string | null = null, versionId: string | null = null) =>
  ({ body, targetMemberId, targetGroupId, versionId, requestId: randomUUID() });

test('纯管理员、另一期成员和已停用的助教均不能进入或写入本期观察', async () => {
  const { current, admin, teacher, ta, student, otherTeacher, otherStudent } = await fixture();
  const subject = { memberId: student.id };
  const observation = note('团队内部短记', student.id);
  await recordTeachingObservation(teacher.userId, current.id, observation);
  await db.courseMember.update({ where: { id: ta.id }, data: { status: 'INACTIVE' } });

  for (const userId of [admin.id, otherTeacher.userId, ta.userId]) {
    await assert.rejects(getTeachingObservations(userId, current.id, subject), DomainError);
    await assert.rejects(getTeachingSubject(userId, current.id, subject), DomainError);
    await assert.rejects(recordTeachingObservation(userId, current.id, observation), DomainError);
    await assert.rejects(sendTeachingFeedback(userId, current.id, note('不得外发', student.id)), DomainError);
  }
  await assert.rejects(getStudentTeachingFeedback(otherStudent.userId, current.id), DomainError);
  await assert.rejects(recordTeachingObservation(teacher.userId, current.id, note('跨期学生', otherStudent.id)), DomainError);
  await assert.rejects(sendTeachingFeedback(teacher.userId, current.id, note('跨期学生', otherStudent.id)), DomainError);
  assert.equal(await db.teachingObservation.count({ where: { offeringId: current.id } }), 1);
  assert.equal(await db.teachingFeedback.count({ where: { offeringId: current.id } }), 0);
});

test('未分组学生的个人成果可关联观察及反馈，停用后保留教学历史而关闭收件', async () => {
  const { current, teacher, ta, student } = await fixture();
  const assignment = await createAssignment(teacher.userId, current.id, {
    title: '未分组个人材料', description: '个人介绍', mode: 'INDIVIDUAL', status: 'PUBLISHED', dueAt: null,
  });
  const version = await submitAssignment(student.userId, current.id, assignment.id,
    await confirmedSubmissionInput(student.userId, current.id, assignment.id));
  await recordTeachingObservation(ta.userId, current.id, note('只给团队', student.id, null, version.id));
  await sendTeachingFeedback(ta.userId, current.id, note('只给学生', student.id, null, version.id));
  const data = await getTeachingSubject(teacher.userId, current.id, { memberId: student.id });
  assert.deepEqual(data.member?.groupMemberships, []);
  assert.deepEqual(data.results.map(result => result.id), [version.id]);
  const inbox = await getStudentTeachingFeedback(student.userId, current.id);
  assert.deepEqual(inbox.map(entry => [entry.body, entry.result?.id]), [['只给学生', version.id]]);
  await db.courseMember.update({ where: { id: student.id }, data: { status: 'INACTIVE' } });
  await assert.rejects(getStudentTeachingFeedback(student.userId, current.id), DomainError);
  await assert.rejects(sendTeachingFeedback(ta.userId, current.id, note('不发给已停用学生', student.id)), DomainError);
  const historical = await getTeachingObservations(ta.userId, current.id, { memberId: student.id });
  assert.deepEqual(historical.observations.map(entry => entry.body), ['只给团队']);
  assert.deepEqual(historical.feedback.map(entry => entry.body), ['只给学生']);
});

test('加入再离开的小组成员保留当时收到的组反馈，但不会永久取得旧成果读取权', async () => {
  const { current, teacher, ta, student, otherStudent } = await fixture();
  const late = await db.courseMember.create({ data: { offeringId: current.id, role: 'STUDENT', userId: otherStudent.userId } });
  const group = await db.group.create({ data: { offeringId: current.id, name: '原组' } });
  const next = await db.group.create({ data: { offeringId: current.id, name: '接手组' } });
  await moveStudentToGroup(teacher.userId, current.id, group.id, student.id);
  const assignment = await createAssignment(teacher.userId, current.id, {
    title: '小组原成果', description: '先交', mode: 'GROUP', status: 'PUBLISHED', dueAt: null,
  });
  const version = await submitAssignment(student.userId, current.id, assignment.id,
    await confirmedSubmissionInput(student.userId, current.id, assignment.id));
  await moveStudentToGroup(teacher.userId, current.id, group.id, late.id);
  await sendTeachingFeedback(ta.userId, current.id, note('全组指导', null, group.id, version.id));
  await sendTeachingFeedback(ta.userId, current.id, note('原组员个人反馈', student.id, null, version.id));
  assert.deepEqual((await getStudentTeachingFeedback(late.userId, current.id)).map(entry => [entry.body, entry.result?.id]),
    [['全组指导', version.id]]);
  await moveStudentToGroup(teacher.userId, current.id, next.id, late.id);
  const [inbox] = await getStudentTeachingFeedback(late.userId, current.id);
  assert.equal(inbox.body, '全组指导');
  assert.equal(inbox.hasResultContext, true);
  assert.equal(inbox.result, null);
  assert.ok(!JSON.stringify(inbox).includes(version.id));
  assert.equal(await db.submissionParticipant.count({ where: { versionId: version.id, courseMemberId: late.id } }), 0);
});
