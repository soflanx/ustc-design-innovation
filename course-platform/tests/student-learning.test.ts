import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { db } from '../src/lib/db';
import { DomainError, moveStudentToGroup } from '../src/lib/management';
import { addFeedback, createAssignment, getAssignmentDetail, setSubmissionCorrectionWindow, submitAssignment, updateAssignment } from '../src/lib/teaching';
import { recordTeachingObservation, sendTeachingFeedback } from '../src/lib/teaching-observations';
import { getStudentLearning } from '../src/lib/student-learning';
import { confirmedSubmissionInput } from './submission-fixture';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(() => db.$disconnect());

async function fixture() {
  const key = randomUUID();
  const course = await db.course.create({ data: { slug: key, title: '学习记录测试' } });
  const term = await db.term.create({ data: { slug: key, name: '测试学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } });
  const offering = await db.courseOffering.create({ data: { courseId: course.id, termId: term.id, title: '本期', status: 'ACTIVE' } });
  const members = await Promise.all(['teacher', 'a', 'b', 'c'].map((name, i) => db.courseMember.create({ data: {
    offering: { connect: { id: offering.id } }, role: i ? 'STUDENT' : 'TEACHER', user: { create: { name, email: `${key}-${name}@test.invalid` } },
  } })));
  const [teacher, a, b, c] = members;
  const [one, two] = await Promise.all(['一组', '二组'].map(name => db.group.create({ data: { offeringId: offering.id, name } })));
  const assignment = async (mode: 'GROUP' | 'INDIVIDUAL', title = mode) => createAssignment(teacher.userId, offering.id, { title, description: '要求', mode, status: 'PUBLISHED', dueAt: null });
  const join = (member: typeof a, group: typeof one) => moveStudentToGroup(teacher.userId, offering.id, group.id, member.id);
  const submit = async (member: typeof a, task: Awaited<ReturnType<typeof assignment>>, body = '成果') => submitAssignment(member.userId, offering.id, task.id, await confirmedSubmissionInput(member.userId, offering.id, task.id, body));
  const learning = (member = a) => getStudentLearning(member.userId, offering.id);
  return { course, term, offering, teacher, a, b, c, one, two, assignment, join, submit, learning };
}
const guidance = (body: string, targetMemberId: string | null, targetGroupId: string | null = null, versionId: string | null = null) => ({ body, targetMemberId, targetGroupId, versionId, requestId: randomUUID() });

test('未分组仍可开始个人任务，并能读到小组任务的入口', async () => {
  const f = await fixture();
  const personal = await f.assignment('INDIVIDUAL');
  const group = await f.assignment('GROUP');
  const version = await f.submit(f.a, personal, '个人介绍');
  const data = await f.learning();
  assert.equal(data.currentGroup, null);
  assert.equal(data.currentAssignments.find(x => x.id === personal.id)?.currentVersion?.id, version.id);
  assert.equal(data.currentAssignments.find(x => x.id === group.id)?.progress.state, 'UNGROUPED');
  assert.equal(data.currentAssignments.find(x => x.id === group.id)?.canSubmit, false);
  assert.deepEqual(data.participatedResults.flatMap(x => x.versions.map(v => v.id)), [version.id]);
});

test('组员代交时按提交时参与快照记录经历', async () => {
  const f = await fixture(); await f.join(f.a, f.one); await f.join(f.b, f.one);
  const task = await f.assignment('GROUP'); const version = await f.submit(f.b, task);
  const data = await f.learning(); const result = data.participatedResults[0].versions[0];
  assert.equal(result.id, version.id); assert.equal(result.submittedBy.id, f.b.id);
  assert.deepEqual(new Set(result.participants.map(x => x.id)), new Set([f.a.id, f.b.id]));
  assert.equal(data.currentAssignments[0].currentVersion?.hasParticipated, true);
});

test('入组前成果可共享读取但不计为自己的经历', async () => {
  const f = await fixture(); await f.join(f.b, f.one);
  const task = await f.assignment('GROUP'); const version = await f.submit(f.b, task);
  await f.join(f.a, f.one);
  const data = await f.learning();
  assert.equal(data.currentAssignments[0].currentVersion?.id, version.id);
  assert.equal(data.currentAssignments[0].currentVersion?.hasParticipated, false);
  assert.deepEqual(data.participatedResults, []);
  assert.equal(await db.submissionParticipant.count({ where: { versionId: version.id, courseMemberId: f.a.id } }), 0);
});

test('调组后当前组任务和本人旧参与同时保留', async () => {
  const f = await fixture(); await f.join(f.a, f.one); await f.join(f.b, f.one); await f.join(f.c, f.two);
  const task = await f.assignment('GROUP'); const old = await f.submit(f.b, task, '旧参与');
  const current = await f.submit(f.c, task, '新组已有'); await f.join(f.a, f.two);
  const data = await f.learning();
  assert.equal(data.currentGroup?.id, f.two.id); assert.equal(data.currentAssignments[0].currentVersion?.id, current.id);
  assert.equal(data.currentAssignments[0].currentVersion?.hasParticipated, false);
  assert.deepEqual(data.participatedResults.flatMap(x => x.versions.map(v => v.id)), [old.id]);
  assert.equal(data.groupHistory.length, 2);
});

test('离组后旧组新增成果不进入经历或当前任务', async () => {
  const f = await fixture(); await f.join(f.a, f.one); await f.join(f.b, f.one);
  const task = await f.assignment('GROUP'); const old = await f.submit(f.b, task, '曾参与');
  await f.join(f.a, f.two); const later = await f.submit(f.b, task, '离组之后');
  const data = await f.learning();
  assert.equal(data.currentAssignments[0].currentVersion, null);
  assert.deepEqual(data.participatedResults.flatMap(x => x.versions.map(v => v.id)), [old.id]);
  assert.ok(!JSON.stringify(data).includes(later.id)); assert.ok(!JSON.stringify(data).includes('离组之后'));
});

test('个人、组和版本指导保留收件边界，内部观察不可见', async () => {
  const f = await fixture(); await f.join(f.b, f.one);
  const task = await f.assignment('GROUP'); const old = await f.submit(f.b, task);
  await f.join(f.a, f.one);
  await sendTeachingFeedback(f.teacher.userId, f.offering.id, guidance('个人指导', f.a.id));
  await sendTeachingFeedback(f.teacher.userId, f.offering.id, guidance('组指导', null, f.one.id, old.id));
  await sendTeachingFeedback(f.teacher.userId, f.offering.id, guidance('他人私信', f.b.id));
  await recordTeachingObservation(f.teacher.userId, f.offering.id, guidance('内部观察', f.a.id));
  let data = await f.learning();
  assert.equal(data.guidance.find(x => x.body === '个人指导')?.recipientBasis, 'PERSONAL');
  assert.equal(data.guidance.find(x => x.body === '组指导')?.result?.id, old.id);
  assert.ok(!JSON.stringify(data).includes('他人私信')); assert.ok(!JSON.stringify(data).includes('内部观察'));
  await f.join(f.a, f.two); data = await f.learning();
  const groupFeedback = data.guidance.find(x => x.body === '组指导')!;
  assert.equal(groupFeedback.recipientBasis, 'RECEIVED_GROUP'); assert.equal(groupFeedback.hasResultContext, true);
  assert.equal(groupFeedback.result, null); assert.ok(!JSON.stringify(groupFeedback).includes(old.id));
});

test('截止后只向指定成果开放更正，归档后保持只读', async () => {
  const f = await fixture(); await f.join(f.a, f.one); await f.join(f.b, f.two);
  const task = await f.assignment('GROUP'); const version = await f.submit(f.a, task);
  const dueAt = new Date(Date.now() - 60_000); const until = new Date(Date.now() + 600_000);
  await updateAssignment(f.teacher.userId, f.offering.id, task.id, { title: task.title, description: '要求', mode: 'GROUP', status: 'PUBLISHED', dueAt }, task.revision);
  await setSubmissionCorrectionWindow(f.teacher.userId, f.offering.id, task.id, version.submissionId, 0, until);
  assert.equal((await f.learning()).currentAssignments[0].canSubmit, true);
  assert.equal((await f.learning()).currentAssignments[0].correctionUntil?.getTime(), until.getTime());
  assert.equal((await f.learning(f.b)).currentAssignments[0].canSubmit, false);
  assert.equal((await f.learning(f.b)).currentAssignments[0].correctionUntil, null);
  await db.courseOffering.update({ where: { id: f.offering.id }, data: { status: 'ARCHIVED' } });
  const archived = await f.learning(); assert.equal(archived.currentAssignments[0].canSubmit, false);
  assert.equal(archived.currentAssignments[0].correctionUntil, null); assert.equal(archived.participatedResults[0].versions[0].id, version.id);
});

test('跨期、非学生及停用成员被拒绝；旧评阅状态与详情一致', async () => {
  const f = await fixture(); const task = await f.assignment('INDIVIDUAL');
  const submission = await db.submission.create({ data: { offeringId: f.offering.id, assignmentId: task.id, courseMemberId: f.a.id } });
  const version = await db.submissionVersion.create({ data: { offeringId: f.offering.id, submissionId: submission.id, version: 1, body: '旧成果', submittedById: f.a.id, finalizedAt: new Date() } });
  for (const expected of ['PENDING', 'LEGACY_UNKNOWN'] as const) {
    if (expected === 'LEGACY_UNKNOWN') await addFeedback(f.teacher.userId, f.offering.id, version.id, '旧评语');
    assert.equal((await f.learning()).currentAssignments[0].progress.reviewState, expected);
    assert.equal((await getAssignmentDetail(f.a.userId, f.offering.id, task.id)).progress?.reviewState, expected);
  }
  const otherTerm = await db.term.create({ data: { slug: randomUUID(), name: '另期', startDate: new Date('2031-09-01'), endDate: new Date('2032-01-01') } });
  const other = await db.courseOffering.create({ data: { courseId: f.course.id, termId: otherTerm.id, title: '另一期', status: 'ACTIVE' } });
  await assert.rejects(getStudentLearning(f.a.userId, other.id), DomainError);
  await assert.rejects(getStudentLearning(f.teacher.userId, f.offering.id), DomainError);
  await db.courseMember.update({ where: { id: f.a.id }, data: { status: 'INACTIVE' } });
  await assert.rejects(f.learning(), DomainError);
});
