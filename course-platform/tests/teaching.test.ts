import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { DomainError, moveStudentToGroup } from '../src/lib/management';
import {
  type AssignmentInput, createAssignment, updateAssignment, submitAssignment, addFeedback,
  getAssignmentIndex, getAssignmentDetail, getSubmissionVersion,
} from '../src/lib/teaching';

// The runner creates this database and destroys it afterwards. Never write
// fixtures when this file is accidentally run against the application database.
assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(async () => { await db.$disconnect(); });

const denied = (promise: Promise<unknown>) => assert.rejects(promise, DomainError);
const input = (extra: Partial<AssignmentInput> = {}): AssignmentInput => ({
  title: '观察记录', description: '提交本周观察与发现。', mode: 'INDIVIDUAL', status: 'PUBLISHED', dueAt: null, ...extra,
});
const submissionInput = (body = '本周的观察记录', expectedGroupId: string | null = null) => ({ body, requestId: randomUUID(), expectedGroupId });

async function fixture() {
  const key = randomUUID();
  const users = await Promise.all(['teacher', 'student', 'peer', 'newcomer', 'ta', 'admin', 'outsider'].map(name => db.user.create({
    data: { email: `${name}-${key}@test.invalid`, name, isAdmin: name === 'admin' },
  })));
  const [teacher, student, peer, newcomer, ta, admin, outsider] = users;
  const course = await db.course.create({ data: { slug: key, title: '作业服务隔离测试' } });
  const term = await db.term.create({ data: { slug: key, name: '测试学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } });
  const offering = await db.courseOffering.create({ data: { courseId: course.id, termId: term.id, title: '测试开课', status: 'ACTIVE' } });
  const [teacherMember, studentMember, peerMember, newcomerMember, taMember] = await Promise.all([
    [teacher, 'TEACHER'], [student, 'STUDENT'], [peer, 'STUDENT'], [newcomer, 'STUDENT'], [ta, 'TA'],
  ].map(([user, role]) => db.courseMember.create({
    data: { offeringId: offering.id, userId: (user as typeof teacher).id, role: role as 'TEACHER' | 'STUDENT' | 'TA' },
  })));
  const [a, b] = await Promise.all(['A组', 'B组'].map(name => db.group.create({ data: { offeringId: offering.id, name } })));
  return { teacher, student, peer, newcomer, ta, admin, outsider, offering, teacherMember, studentMember, peerMember, newcomerMember, taMember, a, b };
}

test('作业管理仅允许教师和管理员，并在服务层验证文本、状态、模式和截止时间', async () => {
  const f = await fixture();
  for (const actor of [f.student, f.ta, f.outsider]) await denied(createAssignment(actor.id, f.offering.id, input()));
  for (const invalid of [
    { title: ' ' }, { title: '长'.repeat(101) }, { description: '长'.repeat(12001) },
    { dueAt: new Date('invalid') }, { mode: 'INVALID' }, { status: 'INVALID' }, { status: 'ARCHIVED' },
  ]) await denied(createAssignment(f.teacher.id, f.offering.id, input(invalid as Partial<AssignmentInput>)));
  assert.equal(await db.assignment.count({ where: { offeringId: f.offering.id } }), 0);
  const assignment = await createAssignment(f.admin.id, f.offering.id, input({ status: 'DRAFT' }));
  await denied(updateAssignment(f.student.id, f.offering.id, assignment.id, input()));
  await denied(updateAssignment(f.ta.id, f.offering.id, assignment.id, input()));
  await denied(updateAssignment(f.teacher.id, f.offering.id, assignment.id, input({ status: 'ARCHIVED' })));
  await updateAssignment(f.teacher.id, f.offering.id, assignment.id, input());
  await denied(updateAssignment(f.teacher.id, f.offering.id, assignment.id, input({ status: 'DRAFT' })));
  await updateAssignment(f.teacher.id, f.offering.id, assignment.id, input({ status: 'ARCHIVED' }));
  await denied(updateAssignment(f.teacher.id, f.offering.id, assignment.id, input({ status: 'DRAFT' })));
  assert.equal((await getAssignmentIndex(f.student.id, f.offering.id)).assignments[0].status, 'ARCHIVED');
});

test('学生看不到草稿；筹备课程、未发布或已结束作业不收新提交', async () => {
  const f = await fixture();
  const draft = await createAssignment(f.teacher.id, f.offering.id, input({ status: 'DRAFT' }));
  assert.equal((await getAssignmentIndex(f.student.id, f.offering.id)).assignments.length, 0);
  assert.equal((await getAssignmentIndex(f.ta.id, f.offering.id)).assignments.length, 1);
  await denied(getAssignmentDetail(f.student.id, f.offering.id, draft.id));
  await denied(submitAssignment(f.student.id, f.offering.id, draft.id, submissionInput()));
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input());
  await db.courseOffering.update({ where: { id: f.offering.id }, data: { status: 'DRAFT' } });
  assert.equal((await getAssignmentDetail(f.student.id, f.offering.id, assignment.id)).canSubmit, false);
  await denied(submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput()));
  await db.courseOffering.update({ where: { id: f.offering.id }, data: { status: 'ACTIVE' } });
  await updateAssignment(f.teacher.id, f.offering.id, assignment.id, input({ status: 'ARCHIVED' }));
  await denied(submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput()));
  assert.equal(await db.submissionVersion.count({ where: { offeringId: f.offering.id } }), 0);
  assert.equal(await db.submission.count({ where: { offeringId: f.offering.id } }), 0);
});

test('个人提交一次事务生成完整快照并封存；版本递增，重复请求不重建或覆盖', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input());
  const request = submissionInput(' 第一版 ');
  const first = await submitAssignment(f.student.id, f.offering.id, assignment.id, request);
  assert.ok(first.finalizedAt);
  assert.equal(first.body, '第一版');
  assert.equal(first.id, request.requestId);
  assert.equal(first.version, 1);
  assert.equal((await submitAssignment(f.student.id, f.offering.id, assignment.id, request)).id, first.id);
  await denied(submitAssignment(f.student.id, f.offering.id, assignment.id, { ...request, body: '试图覆盖' }));
  await denied(submitAssignment(f.peer.id, f.offering.id, assignment.id, request));
  const second = await submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput('第二版'));
  assert.equal(second.version, 2);
  const detail = await getSubmissionVersion(f.student.id, f.offering.id, first.id);
  assert.deepEqual(detail.version.participants, [{ id: f.studentMember.id, name: 'student' }]);
  assert.equal(detail.version.ownerLabel, 'student');
  assert.equal(detail.version.submittedBy.id, f.studentMember.id);
  await assert.rejects(db.submissionVersion.update({ where: { id: first.id }, data: { body: '篡改' } }));
  await assert.rejects(db.submissionParticipant.deleteMany({ where: { versionId: first.id } }));
  await denied(updateAssignment(f.teacher.id, f.offering.id, assignment.id, input({ mode: 'GROUP' })));
  const peerDetail = await getAssignmentDetail(f.peer.id, f.offering.id, assignment.id);
  assert.equal(peerDetail.versions.length, 0);
  await denied(getSubmissionVersion(f.peer.id, f.offering.id, first.id));
  const peerIndex = (await getAssignmentIndex(f.peer.id, f.offering.id)).assignments[0];
  assert.equal(peerIndex.versionCount, 0);
  assert.equal(peerIndex.latestVersion, null);
  assert.equal(await db.submissionVersion.count({ where: { offeringId: f.offering.id, finalizedAt: null } }), 0);
});

test('并发首交和后续提交保留一个归属容器、连续版本号；并发重复请求只生成一版', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input({ mode: 'GROUP' }));
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.studentMember.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.peerMember.id);
  const results = await Promise.all([
    submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput('学生提交', f.a.id)),
    submitAssignment(f.peer.id, f.offering.id, assignment.id, submissionInput('组员提交', f.a.id)),
    submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput('后续提交', f.a.id)),
  ]);
  assert.deepEqual(results.map(row => row.version).sort(), [1, 2, 3]);
  assert.equal(new Set(results.map(row => row.submissionId)).size, 1);
  const request = submissionInput('双击提交', f.a.id);
  const duplicate = await Promise.all([
    submitAssignment(f.student.id, f.offering.id, assignment.id, request),
    submitAssignment(f.student.id, f.offering.id, assignment.id, request),
  ]);
  assert.equal(duplicate[0].id, duplicate[1].id);
  assert.equal(duplicate[0].version, 4);
  assert.equal(await db.submission.count({ where: { assignmentId: assignment.id } }), 1);
  assert.equal(await db.submissionVersion.count({ where: { offeringId: f.offering.id } }), 4);
  assert.equal(await db.submissionParticipant.count({ where: { offeringId: f.offering.id } }), 8);
});

test('调组后旧版依快照可读，新组员不能看加入前版本，离组者不能看后续版本或反馈', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input({ mode: 'GROUP' }));
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.studentMember.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.peerMember.id);
  const oldRequest = submissionInput('调组前', f.a.id);
  const old = await submitAssignment(f.student.id, f.offering.id, assignment.id, oldRequest);
  await addFeedback(f.ta.id, f.offering.id, old.id, '旧组反馈');
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.peerMember.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.newcomerMember.id);
  const latest = await submitAssignment(f.newcomer.id, f.offering.id, assignment.id, submissionInput('调组后', f.a.id));
  await addFeedback(f.teacher.id, f.offering.id, latest.id, '新组反馈');
  assert.deepEqual((await getSubmissionVersion(f.peer.id, f.offering.id, old.id)).version.participants.map(row => row.id).sort(), [f.studentMember.id, f.peerMember.id].sort());
  assert.deepEqual((await getSubmissionVersion(f.newcomer.id, f.offering.id, latest.id)).version.participants.map(row => row.id).sort(), [f.studentMember.id, f.newcomerMember.id].sort());
  await denied(getSubmissionVersion(f.newcomer.id, f.offering.id, old.id));
  await denied(getSubmissionVersion(f.peer.id, f.offering.id, latest.id));
  const oldDetail = await getAssignmentDetail(f.peer.id, f.offering.id, assignment.id);
  assert.deepEqual(oldDetail.versions.map(row => row.id), [old.id]);
  assert.deepEqual(oldDetail.versions[0].feedback.map(row => row.body), ['旧组反馈']);
  const newIndex = (await getAssignmentIndex(f.newcomer.id, f.offering.id)).assignments[0];
  assert.equal(newIndex.versionCount, 1);
  assert.equal(newIndex.latestVersion?.id, latest.id);
  const oldIndex = (await getAssignmentIndex(f.peer.id, f.offering.id)).assignments[0];
  assert.equal(oldIndex.versionCount, 1);
  assert.equal(oldIndex.latestVersion?.id, old.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.studentMember.id);
  assert.equal((await submitAssignment(f.student.id, f.offering.id, assignment.id, oldRequest)).id, old.id);
  assert.equal(await db.submissionVersion.count({ where: { offeringId: f.offering.id } }), 2);
});

test('小组快照只纳入当前有效学生，未分组与停用成员拒绝提交和读取', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input({ mode: 'GROUP' }));
  await denied(submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput()));
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.studentMember.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.peerMember.id);
  await db.courseMember.update({ where: { id: f.peerMember.id }, data: { status: 'INACTIVE' } });
  const version = await submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput('有效组员提交', f.a.id));
  assert.deepEqual((await getSubmissionVersion(f.student.id, f.offering.id, version.id)).version.participants.map(row => row.id), [f.studentMember.id]);
  await denied(submitAssignment(f.peer.id, f.offering.id, assignment.id, submissionInput()));
  await denied(getAssignmentIndex(f.peer.id, f.offering.id));
  await denied(getSubmissionVersion(f.peer.id, f.offering.id, version.id));
  await db.courseMember.update({ where: { id: f.studentMember.id }, data: { status: 'INACTIVE' } });
  await denied(submitAssignment(f.student.id, f.offering.id, assignment.id, { body: version.body, requestId: version.id }));
  await denied(getSubmissionVersion(f.student.id, f.offering.id, version.id));
  assert.equal(await db.submissionVersion.count({ where: { offeringId: f.offering.id } }), 1);
});

test('全期教师与助教可反馈封存版本，学生和没有本期教学身份的管理员不能署名', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input());
  const version = await submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput());
  await denied(addFeedback(f.student.id, f.offering.id, version.id, '冒名反馈'));
  await denied(addFeedback(f.admin.id, f.offering.id, version.id, '没有教学身份'));
  await denied(addFeedback(f.outsider.id, f.offering.id, version.id, '外部用户'));
  assert.equal((await getAssignmentDetail(f.admin.id, f.offering.id, assignment.id)).canReview, false);
  assert.equal((await getAssignmentDetail(f.ta.id, f.offering.id, assignment.id)).canReview, true);
  await addFeedback(f.ta.id, f.offering.id, version.id, '助教全期反馈');
  await addFeedback(f.teacher.id, f.offering.id, version.id, '教师反馈');
  const feedback = (await getSubmissionVersion(f.student.id, f.offering.id, version.id)).version.feedback;
  assert.deepEqual(feedback.map(row => row.reviewer.role).sort(), ['TA', 'TEACHER']);
  assert.equal(await db.review.count({ where: { offeringId: f.offering.id, score: { not: null } } }), 0);
  assert.equal(await db.gradeRecord.count({ where: { offeringId: f.offering.id } }), 0);
  await db.courseMember.update({ where: { id: f.taMember.id }, data: { status: 'INACTIVE' } });
  await denied(addFeedback(f.ta.id, f.offering.id, version.id, '停用助教'));
  assert.equal(await db.review.count({ where: { offeringId: f.offering.id } }), 2);
  const draft = await db.submissionVersion.create({
    data: { offeringId: f.offering.id, submissionId: version.submissionId, version: 2, body: '内部未封存', submittedById: f.studentMember.id },
  });
  await denied(addFeedback(f.teacher.id, f.offering.id, draft.id, '不应发表'));
  await denied(getSubmissionVersion(f.teacher.id, f.offering.id, draft.id));
  assert.equal((await getAssignmentDetail(f.teacher.id, f.offering.id, assignment.id)).versions.length, 1);
});

test('跨开课的作业、版本、反馈和重复请求标识均不能越权读取或写入', async () => {
  const f = await fixture(); const other = await fixture();
  const a = await createAssignment(f.teacher.id, f.offering.id, input());
  const b = await createAssignment(other.teacher.id, other.offering.id, input());
  const version = await submitAssignment(other.student.id, other.offering.id, b.id, submissionInput());
  await denied(updateAssignment(f.teacher.id, f.offering.id, b.id, input()));
  await denied(submitAssignment(f.student.id, f.offering.id, b.id, submissionInput()));
  await denied(addFeedback(f.teacher.id, f.offering.id, version.id, '越课反馈'));
  await denied(getAssignmentDetail(f.student.id, f.offering.id, b.id));
  await denied(getSubmissionVersion(f.teacher.id, f.offering.id, version.id));
  await denied(getAssignmentIndex(f.outsider.id, f.offering.id));
  await denied(submitAssignment(f.student.id, f.offering.id, a.id, { requestId: version.id, body: version.body }));
  assert.equal(await db.submissionVersion.count({ where: { offeringId: f.offering.id } }), 0);
  assert.equal(await db.review.count({ where: { offeringId: f.offering.id } }), 0);
});

test('截止时间以服务端时间为准，恰好到期拒绝；成功请求到期后重试不增加版本', async t => {
  const f = await fixture();
  const now = Date.now() + 60_000;
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input({ dueAt: new Date(now) }));
  t.mock.timers.enable({ apis: ['Date'], now: now - 1 });
  const request = submissionInput('截止前一毫秒');
  const version = await submitAssignment(f.student.id, f.offering.id, assignment.id, request);
  t.mock.timers.setTime(now);
  await denied(submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput('恰好到期')));
  assert.equal((await getAssignmentDetail(f.student.id, f.offering.id, assignment.id)).canSubmit, false);
  assert.equal((await submitAssignment(f.student.id, f.offering.id, assignment.id, request)).id, version.id);
  assert.equal(await db.submissionVersion.count({ where: { offeringId: f.offering.id } }), 1);
  assert.equal(await db.submissionParticipant.count({ where: { offeringId: f.offering.id } }), 1);
});

test('正文、反馈和提交UUID验证失败不产生容器、版本或反馈', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input());
  for (const bad of [{ body: ' ', requestId: randomUUID() }, { body: '长'.repeat(12001), requestId: randomUUID() }, { body: '有效正文', requestId: 'forged' }]) {
    await denied(submitAssignment(f.student.id, f.offering.id, assignment.id, bad));
  }
  assert.equal(await db.submission.count({ where: { offeringId: f.offering.id } }), 0);
  const version = await submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput('长'.repeat(12000)));
  await denied(addFeedback(f.teacher.id, f.offering.id, version.id, ' '));
  await denied(addFeedback(f.teacher.id, f.offering.id, version.id, '长'.repeat(12001)));
  assert.equal(await db.review.count({ where: { offeringId: f.offering.id } }), 0);
});

test('归档课程拒绝所有教学写入，学生和教学团队继续读取历史版本及反馈', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input());
  const version = await submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput());
  await addFeedback(f.teacher.id, f.offering.id, version.id, '归档前反馈');
  await db.courseOffering.update({ where: { id: f.offering.id }, data: { status: 'ARCHIVED' } });
  await denied(createAssignment(f.teacher.id, f.offering.id, input()));
  await denied(updateAssignment(f.admin.id, f.offering.id, assignment.id, input({ title: '覆盖归档' })));
  await denied(submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput()));
  await denied(addFeedback(f.ta.id, f.offering.id, version.id, '归档后反馈'));
  const studentView = await getAssignmentDetail(f.student.id, f.offering.id, assignment.id);
  assert.equal(studentView.canSubmit, false);
  assert.equal(studentView.versions[0].feedback[0].body, '归档前反馈');
  const staffView = await getAssignmentDetail(f.teacher.id, f.offering.id, assignment.id);
  assert.equal(staffView.canManage, false);
  assert.equal(staffView.canReview, false);
  assert.equal(staffView.versions.length, 1);
  assert.equal(await db.submissionVersion.count({ where: { offeringId: f.offering.id } }), 1);
  assert.equal(await db.review.count({ where: { offeringId: f.offering.id } }), 1);
});

test('并发调组与提交的归属、提交人及参与者快照保持同一历史状态', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input({ mode: 'GROUP' }));
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.studentMember.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.peerMember.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.newcomerMember.id);
  const [submitted, moved] = await Promise.allSettled([
    submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput('调组同时提交', f.a.id)),
    moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.studentMember.id),
  ]);
  assert.equal(moved.status, 'fulfilled');
  if (submitted.status === 'rejected') {
    assert.ok(submitted.reason instanceof DomainError);
    assert.match(submitted.reason.message, /小组已变化/);
    assert.equal(await db.submission.count({ where: { offeringId: f.offering.id } }), 0);
    assert.equal(await db.submissionVersion.count({ where: { offeringId: f.offering.id } }), 0);
    return;
  }
  const version = submitted.value;
  const owner = await db.submission.findUniqueOrThrow({ where: { id: version.submissionId } });
  const snapshot = (await getSubmissionVersion(f.student.id, f.offering.id, version.id)).version.participants.map(row => row.id).sort();
  assert.equal(owner.groupId, f.a.id);
  assert.deepEqual(snapshot, [f.studentMember.id, f.peerMember.id].sort());
  assert.equal(await db.submissionVersion.count({ where: { offeringId: f.offering.id, finalizedAt: null } }), 0);
});

test('处理概览按当前个人的最新封存版计数；旧版反馈不抵扣新版，退出者只保留历史', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input());
  let detail = await getAssignmentDetail(f.teacher.id, f.offering.id, assignment.id);
  assert.deepEqual(detail.summary, { totalExpectedCount: 3, submittedCount: 0, pendingFeedbackCount: 0, feedbackCount: 0 });
  assert.equal(detail.reviewQueue.length, 3);
  assert.ok(detail.reviewQueue.every(row => row.latestVersionId === null));
  const first = await submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput('初稿'));
  await addFeedback(f.teacher.id, f.offering.id, first.id, '第一条反馈');
  await addFeedback(f.ta.id, f.offering.id, first.id, '第二条反馈');
  detail = await getAssignmentDetail(f.teacher.id, f.offering.id, assignment.id);
  assert.deepEqual(detail.summary, { totalExpectedCount: 3, submittedCount: 1, pendingFeedbackCount: 0, feedbackCount: 1 });
  assert.equal(detail.reviewQueue.find(row => row.id === f.studentMember.id)?.feedbackCount, 2);
  assert.deepEqual((await getAssignmentIndex(f.student.id, f.offering.id)).assignments[0].progress, {
    state: 'FEEDBACK_AVAILABLE', latestVersionId: first.id, feedbackCount: 2,
  });
  const second = await submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput('按反馈修改的新稿'));
  // An unsealed higher version must not become the current reviewed target.
  await db.submissionVersion.create({ data: {
    offeringId: f.offering.id, submissionId: second.submissionId,
    version: 3, submittedById: f.studentMember.id, body: '内部未封存记录',
  } });
  detail = await getAssignmentDetail(f.teacher.id, f.offering.id, assignment.id);
  assert.deepEqual(detail.summary, { totalExpectedCount: 3, submittedCount: 1, pendingFeedbackCount: 1, feedbackCount: 0 });
  const queueItem = detail.reviewQueue.find(row => row.id === f.studentMember.id)!;
  assert.equal(queueItem.latestVersionId, second.id);
  assert.equal(queueItem.latestVersionNumber, 2);
  assert.equal(queueItem.submittedAt?.getTime(), second.submittedAt.getTime());
  assert.equal(queueItem.feedbackCount, 0);
  assert.equal((await getAssignmentIndex(f.teacher.id, f.offering.id)).assignments[0].summary?.pendingFeedbackCount, 1);
  assert.deepEqual((await getAssignmentIndex(f.student.id, f.offering.id)).assignments[0].progress, {
    state: 'SUBMITTED', latestVersionId: second.id, feedbackCount: 0,
  });
  await db.courseMember.update({ where: { id: f.studentMember.id }, data: { status: 'INACTIVE' } });
  detail = await getAssignmentDetail(f.teacher.id, f.offering.id, assignment.id);
  assert.deepEqual(detail.summary, { totalExpectedCount: 2, submittedCount: 0, pendingFeedbackCount: 0, feedbackCount: 0 });
  assert.ok(!detail.reviewQueue.some(row => row.id === f.studentMember.id));
  assert.equal(detail.versions.length, 2);
  assert.equal((await getAssignmentIndex(f.teacher.id, f.offering.id)).assignments[0].versionCount, 2);
});

test('小组期待数量排除空组和仅含停用学生的小组；助教负责标记跟随当前有效分工', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input({ mode: 'GROUP' }));
  const emptyGroup = await db.group.create({ data: { offeringId: f.offering.id, name: '从未分组的空组' } });
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.studentMember.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.peerMember.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.newcomerMember.id);
  await db.taGroupAssignment.create({ data: { offeringId: f.offering.id, groupId: f.a.id, courseMemberId: f.taMember.id } });
  await db.taGroupAssignment.create({ data: {
    offeringId: f.offering.id, groupId: f.b.id, courseMemberId: f.taMember.id,
    assignedAt: new Date('2020-01-01'), endedAt: new Date('2020-02-01'),
  } });
  const first = await submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput('A组当前版本', f.a.id));
  let detail = await getAssignmentDetail(f.ta.id, f.offering.id, assignment.id);
  assert.deepEqual(detail.summary, { totalExpectedCount: 2, submittedCount: 1, pendingFeedbackCount: 1, feedbackCount: 0 });
  assert.equal(detail.reviewQueue.find(row => row.id === f.a.id)?.assignedToMe, true);
  assert.equal(detail.reviewQueue.find(row => row.id === f.b.id)?.assignedToMe, false);
  assert.ok(!detail.reviewQueue.some(row => row.id === emptyGroup.id));
  assert.ok((await getAssignmentDetail(f.teacher.id, f.offering.id, assignment.id)).reviewQueue.every(row => !row.assignedToMe));
  await db.courseMember.update({ where: { id: f.newcomerMember.id }, data: { status: 'INACTIVE' } });
  detail = await getAssignmentDetail(f.ta.id, f.offering.id, assignment.id);
  assert.equal(detail.summary?.totalExpectedCount, 1);
  assert.deepEqual(detail.reviewQueue.map(row => row.id), [f.a.id]);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.studentMember.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.peerMember.id);
  detail = await getAssignmentDetail(f.ta.id, f.offering.id, assignment.id);
  assert.deepEqual(detail.summary, { totalExpectedCount: 1, submittedCount: 0, pendingFeedbackCount: 0, feedbackCount: 0 });
  assert.equal(detail.reviewQueue[0].id, f.b.id);
  assert.equal(detail.reviewQueue[0].latestVersionId, null);
  assert.equal(detail.reviewQueue[0].assignedToMe, false);
  assert.deepEqual(detail.versions.map(row => row.id), [first.id]);
});

test('学生进度只取当前归属的本人快照；调组不继承新组旧提交或旧组反馈，历史仍可读', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input({ mode: 'GROUP' }));
  let index = (await getAssignmentIndex(f.peer.id, f.offering.id)).assignments[0];
  assert.deepEqual(index.progress, { state: 'UNGROUPED', latestVersionId: null, feedbackCount: 0 });
  assert.equal(index.summary, null);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.studentMember.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.peerMember.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.newcomerMember.id);
  assert.equal((await getAssignmentIndex(f.peer.id, f.offering.id)).assignments[0].progress?.state, 'NOT_SUBMITTED');
  const firstA = await submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput('A组旧版', f.a.id));
  const firstB = await submitAssignment(f.newcomer.id, f.offering.id, assignment.id, submissionInput('B组旧版', f.b.id));
  await addFeedback(f.teacher.id, f.offering.id, firstA.id, 'A组旧反馈');
  await addFeedback(f.ta.id, f.offering.id, firstB.id, 'B组旧反馈');
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.peerMember.id);
  index = (await getAssignmentIndex(f.peer.id, f.offering.id)).assignments[0];
  assert.deepEqual(index.progress, { state: 'NOT_SUBMITTED', latestVersionId: null, feedbackCount: 0 });
  assert.equal(index.latestVersion?.id, firstA.id);
  assert.equal(index.versionCount, 1);
  const peerDetail = await getAssignmentDetail(f.peer.id, f.offering.id, assignment.id);
  assert.deepEqual(peerDetail.reviewQueue, []);
  assert.equal(peerDetail.summary, null);
  assert.deepEqual(peerDetail.progress, index.progress);
  assert.deepEqual(peerDetail.versions.map(row => row.id), [firstA.id]);
  // The staff's group-level overview is independent of this student's snapshot.
  assert.equal((await getAssignmentDetail(f.teacher.id, f.offering.id, assignment.id)).summary?.submittedCount, 2);
  const secondB = await submitAssignment(f.peer.id, f.offering.id, assignment.id, submissionInput('新成员参与B组', f.b.id));
  assert.deepEqual((await getAssignmentIndex(f.peer.id, f.offering.id)).assignments[0].progress, {
    state: 'SUBMITTED', latestVersionId: secondB.id, feedbackCount: 0,
  });
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.newcomerMember.id);
  const newcomerIndex = (await getAssignmentIndex(f.newcomer.id, f.offering.id)).assignments[0];
  assert.deepEqual(newcomerIndex.progress, { state: 'NOT_SUBMITTED', latestVersionId: null, feedbackCount: 0 });
  assert.equal(newcomerIndex.latestVersion?.id, secondB.id);
  assert.equal(newcomerIndex.versionCount, 2);
  await denied(getSubmissionVersion(f.newcomer.id, f.offering.id, firstA.id));
});

test('个人作业助教负责标记根据学生当前小组，未分组和已结束分工不标记', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input());
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.studentMember.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.peerMember.id);
  const taAssignment = await db.taGroupAssignment.create({ data: {
    offeringId: f.offering.id, groupId: f.a.id, courseMemberId: f.taMember.id,
  } });
  let detail = await getAssignmentDetail(f.ta.id, f.offering.id, assignment.id);
  assert.equal(detail.reviewQueue.find(row => row.id === f.studentMember.id)?.assignedToMe, true);
  assert.equal(detail.reviewQueue.find(row => row.id === f.studentMember.id)?.groupId, f.a.id);
  assert.equal(detail.reviewQueue.find(row => row.id === f.peerMember.id)?.assignedToMe, false);
  assert.equal(detail.reviewQueue.find(row => row.id === f.newcomerMember.id)?.groupId, null);
  await db.taGroupAssignment.update({ where: { id: taAssignment.id }, data: { endedAt: new Date() } });
  detail = await getAssignmentDetail(f.ta.id, f.offering.id, assignment.id);
  assert.ok(detail.reviewQueue.every(row => !row.assignedToMe));
  const adminDetail = await getAssignmentDetail(f.admin.id, f.offering.id, assignment.id);
  assert.equal(adminDetail.summary?.totalExpectedCount, 3);
  assert.equal(adminDetail.progress, null);
});

test('小组提交拒绝旧页面归属或伪造组ID且不写入；已成功UUID调组后重试仍返回原版', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input({ mode: 'GROUP' }));
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.studentMember.id);
  const successful = submissionInput('已经提交给A组', f.a.id);
  const first = await submitAssignment(f.student.id, f.offering.id, assignment.id, successful);
  const stale = submissionInput('还停留在A组旧页面的正文', f.a.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.studentMember.id);
  await assert.rejects(submitAssignment(f.student.id, f.offering.id, assignment.id, stale), error => {
    assert.ok(error instanceof DomainError);
    assert.match(error.message, /小组已变化/);
    return true;
  });
  await denied(submitAssignment(f.student.id, f.offering.id, assignment.id, { body: '缺少预期小组', requestId: randomUUID() }));
  assert.equal(await db.submission.count({ where: { assignmentId: assignment.id, groupId: f.b.id } }), 0);
  assert.equal(await db.submissionVersion.count({ where: { offeringId: f.offering.id } }), 1);
  assert.equal(await db.submissionParticipant.count({ where: { offeringId: f.offering.id } }), 1);
  assert.equal((await submitAssignment(f.student.id, f.offering.id, assignment.id, successful)).id, first.id);
  const current = await submitAssignment(f.student.id, f.offering.id, assignment.id, { ...stale, expectedGroupId: f.b.id });
  assert.equal(current.version, 1);
  assert.notEqual(current.submissionId, first.submissionId);
  const personal = await createAssignment(f.teacher.id, f.offering.id, input());
  const own = await submitAssignment(f.student.id, f.offering.id, personal.id, submissionInput('个人作业不依赖组ID', f.a.id));
  assert.ok(own.finalizedAt);
});

test('TA负责范围概览与详情负责队列一致，覆盖个人和小组作业及新版重新待反馈', async () => {
  const f = await fixture();
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.studentMember.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.peerMember.id);
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.newcomerMember.id);
  await db.taGroupAssignment.create({ data: { offeringId: f.offering.id, courseMemberId: f.taMember.id, groupId: f.a.id } });
  const personal = await createAssignment(f.teacher.id, f.offering.id, input({ title: '个人范围' }));
  const group = await createAssignment(f.teacher.id, f.offering.id, input({ title: '小组范围', mode: 'GROUP' }));
  await submitAssignment(f.student.id, f.offering.id, personal.id, submissionInput('负责组学生的个人提交'));
  await submitAssignment(f.newcomer.id, f.offering.id, personal.id, submissionInput('非负责组学生的个人提交'));
  const firstGroup = await submitAssignment(f.student.id, f.offering.id, group.id, submissionInput('负责组第一版', f.a.id));
  await submitAssignment(f.newcomer.id, f.offering.id, group.id, submissionInput('非负责组提交', f.b.id));
  await addFeedback(f.teacher.id, f.offering.id, firstGroup.id, '第一版反馈');
  const personalIndex = (await getAssignmentIndex(f.ta.id, f.offering.id)).assignments.find(row => row.id === personal.id)!;
  assert.deepEqual(personalIndex.mineSummary, { totalExpectedCount: 2, submittedCount: 1, pendingFeedbackCount: 1, feedbackCount: 0 });
  assert.deepEqual(personalIndex.summary, { totalExpectedCount: 3, submittedCount: 2, pendingFeedbackCount: 2, feedbackCount: 0 });
  const firstGroupIndex = (await getAssignmentIndex(f.ta.id, f.offering.id)).assignments.find(row => row.id === group.id)!;
  assert.deepEqual(firstGroupIndex.mineSummary, { totalExpectedCount: 1, submittedCount: 1, pendingFeedbackCount: 0, feedbackCount: 1 });
  const secondGroup = await submitAssignment(f.peer.id, f.offering.id, group.id, submissionInput('负责组第二版待反馈', f.a.id));
  const index = await getAssignmentIndex(f.ta.id, f.offering.id);
  for (const assignment of index.assignments) {
    const detail = await getAssignmentDetail(f.ta.id, f.offering.id, assignment.id);
    const mine = detail.reviewQueue.filter(row => row.assignedToMe);
    const expected = {
      totalExpectedCount: mine.length,
      submittedCount: mine.filter(row => row.latestVersionId !== null).length,
      pendingFeedbackCount: mine.filter(row => row.latestVersionId !== null && row.feedbackCount === 0).length,
      feedbackCount: mine.filter(row => row.latestVersionId !== null && row.feedbackCount > 0).length,
    };
    assert.deepEqual(assignment.mineSummary, expected);
    assert.deepEqual(detail.mineSummary, expected);
  }
  assert.deepEqual(index.assignments.find(row => row.id === group.id)!.mineSummary, {
    totalExpectedCount: 1, submittedCount: 1, pendingFeedbackCount: 1, feedbackCount: 0,
  });
  const groupDetail = await getAssignmentDetail(f.ta.id, f.offering.id, group.id);
  assert.equal(groupDetail.reviewQueue.find(row => row.assignedToMe)?.latestVersionId, secondGroup.id);
  assert.equal(groupDetail.versions.find(row => row.id === firstGroup.id)?.feedback.length, 1);
});

test('无有效分工的TA仅得到空负责统计；学生、教师和管理员不产生个人负责范围', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, input());
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.studentMember.id);
  await submitAssignment(f.student.id, f.offering.id, assignment.id, submissionInput());
  const empty = { totalExpectedCount: 0, submittedCount: 0, pendingFeedbackCount: 0, feedbackCount: 0 };
  assert.deepEqual((await getAssignmentIndex(f.ta.id, f.offering.id)).assignments[0].mineSummary, empty);
  const ended = await db.taGroupAssignment.create({ data: {
    offeringId: f.offering.id, courseMemberId: f.taMember.id, groupId: f.a.id,
  } });
  assert.equal((await getAssignmentIndex(f.ta.id, f.offering.id)).assignments[0].mineSummary?.pendingFeedbackCount, 1);
  await db.taGroupAssignment.update({ where: { id: ended.id }, data: { endedAt: new Date() } });
  const taDetail = await getAssignmentDetail(f.ta.id, f.offering.id, assignment.id);
  assert.deepEqual(taDetail.mineSummary, empty);
  assert.ok(taDetail.reviewQueue.every(row => !row.assignedToMe));
  assert.equal(taDetail.summary?.pendingFeedbackCount, 1);
  // Even an administrator with a TA membership is presented as an administrator.
  const adminMember = await db.courseMember.create({ data: { offeringId: f.offering.id, userId: f.admin.id, role: 'TA' } });
  await db.taGroupAssignment.create({ data: { offeringId: f.offering.id, groupId: f.a.id, courseMemberId: adminMember.id } });
  for (const actor of [f.student, f.teacher, f.admin]) {
    assert.equal((await getAssignmentIndex(actor.id, f.offering.id)).assignments[0].mineSummary, null);
    const detail = await getAssignmentDetail(actor.id, f.offering.id, assignment.id);
    assert.equal(detail.mineSummary, null);
    assert.ok(detail.reviewQueue.every(row => !row.assignedToMe));
  }
});
