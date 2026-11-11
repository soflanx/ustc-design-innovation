import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { DomainError, moveStudentToGroup } from '../src/lib/management';
import { createAssignment, changeAssignmentStatus, getAssignmentDetail, getAssignmentIndex, setSubmissionCorrectionWindow, SubmissionConflictError, submitAssignment, updateAssignment, type AssignmentInput } from '../src/lib/teaching';
import { confirmedSubmissionInput } from './submission-fixture';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(async () => { await db.$disconnect(); });

async function setup() {
  const key = randomUUID();
  const users = await Promise.all(['teacher', 'first', 'second', 'newcomer'].map(name =>
    db.user.create({ data: { name, email: `${name}-${key}@test.invalid` } })));
  const [teacher, first, second, newcomer] = users;
  const course = await db.course.create({ data: { slug: key, title: '附件边界测试' } });
  const term = await db.term.create({ data: { slug: key, name: '测试学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } });
  const offering = await db.courseOffering.create({ data: { courseId: course.id, termId: term.id, title: '测试开课', status: 'ACTIVE' } });
  const [, firstMember, secondMember, newcomerMember] = await Promise.all(users.map((user, index) =>
    db.courseMember.create({ data: { offeringId: offering.id, userId: user.id, role: index ? 'STUDENT' : 'TEACHER' } })));
  const [a, b] = await Promise.all(['A组', 'B组'].map(name => db.group.create({ data: { offeringId: offering.id, name } })));
  await moveStudentToGroup(teacher.id, offering.id, a.id, firstMember.id);
  await moveStudentToGroup(teacher.id, offering.id, a.id, secondMember.id);
  await moveStudentToGroup(teacher.id, offering.id, b.id, newcomerMember.id);
  const input: AssignmentInput = { title: '提交研究材料', description: '交回材料和说明。', mode: 'GROUP', status: 'PUBLISHED', dueAt: null };
  const assignment = await createAssignment(teacher.id, offering.id, input);
  return { teacher, first, second, newcomer, firstMember, newcomerMember, a, b, offering, assignment, input };
}

test('取消暂时阻止指定成果更正，恢复保留有效授权但旧表必须重新确认', async () => {
  const f = await setup();
  const original = await submitAssignment(f.first.id, f.offering.id, f.assignment.id,
    await confirmedSubmissionInput(f.first.id, f.offering.id, f.assignment.id));
  let assignment = await updateAssignment(f.teacher.id, f.offering.id, f.assignment.id,
    { ...f.input, dueAt: new Date(Date.now() - 60_000) }, f.assignment.revision);
  const until = new Date(Date.now() + 600_000);
  await setSubmissionCorrectionWindow(f.teacher.id, f.offering.id, assignment.id, original.submissionId, 0, until);
  const stale = await confirmedSubmissionInput(f.first.id, f.offering.id, assignment.id, '取消前留下的草稿');
  assignment = await changeAssignmentStatus(f.teacher.id, f.offering.id, assignment.id,
    { status: 'CANCELLED', cancellationReason: '调整课堂安排', expectedRevision: assignment.revision });
  const cancelled = (await getAssignmentDetail(f.first.id, f.offering.id, assignment.id)).submissionContext!;
  assert.equal(cancelled.canSubmit, false);
  assert.match(cancelled.blockedReason!, /已取消/);
  await assert.rejects(submitAssignment(f.first.id, f.offering.id, assignment.id,
    await confirmedSubmissionInput(f.first.id, f.offering.id, assignment.id)), /已取消/);
  await assert.rejects(setSubmissionCorrectionWindow(f.teacher.id, f.offering.id, assignment.id,
    original.submissionId, 1, new Date(Date.now() + 900_000)), /仍发布/);
  assignment = await changeAssignmentStatus(f.teacher.id, f.offering.id, assignment.id,
    { status: 'PUBLISHED', expectedRevision: assignment.revision });
  const restored = (await getAssignmentDetail(f.first.id, f.offering.id, assignment.id)).submissionContext!;
  assert.equal(restored.canSubmit, true);
  assert.equal(restored.correctionUntil, until.toISOString());
  const otherGroup = (await getAssignmentDetail(f.newcomer.id, f.offering.id, assignment.id)).submissionContext!;
  assert.equal(otherGroup.canSubmit, false);
  assert.equal(otherGroup.correctionUntil, null);
  await assert.rejects(submitAssignment(f.first.id, f.offering.id, assignment.id, stale), error =>
    error instanceof SubmissionConflictError && error.reasons.includes('requirements'));
  const corrected = await submitAssignment(f.first.id, f.offering.id, assignment.id,
    { ...await confirmedSubmissionInput(f.first.id, f.offering.id, assignment.id, stale.body), requestId: stale.requestId });
  assert.equal(corrected.version, 2);
  assert.equal(await db.submissionCorrectionEvent.count({ where: { submissionId: original.submissionId } }), 1);
});

test('取消期间到期的指定更正授权不会因恢复发布而延长', async () => {
  const f = await setup();
  const original = await submitAssignment(f.first.id, f.offering.id, f.assignment.id,
    await confirmedSubmissionInput(f.first.id, f.offering.id, f.assignment.id));
  let assignment = await updateAssignment(f.teacher.id, f.offering.id, f.assignment.id,
    { ...f.input, dueAt: new Date(Date.now() - 60_000) }, f.assignment.revision);
  await setSubmissionCorrectionWindow(f.teacher.id, f.offering.id, assignment.id, original.submissionId, 0, new Date(Date.now() + 600_000));
  assignment = await changeAssignmentStatus(f.teacher.id, f.offering.id, assignment.id,
    { status: 'CANCELLED', cancellationReason: '暂停', expectedRevision: assignment.revision });
  // Model elapsed wall time without sleeping or weakening the production API's future-date guard.
  await db.submission.update({ where: { id: original.submissionId }, data: { correctionUntil: new Date(Date.now() - 1) } });
  await changeAssignmentStatus(f.teacher.id, f.offering.id, assignment.id,
    { status: 'PUBLISHED', expectedRevision: assignment.revision });
  const restored = (await getAssignmentDetail(f.first.id, f.offering.id, assignment.id)).submissionContext!;
  assert.equal(restored.canSubmit, false);
  assert.equal(restored.correctionUntil, null);
  assert.deepEqual((await getAssignmentDetail(f.teacher.id, f.offering.id, assignment.id)).correctionAuthorizations, []);
  await assert.rejects(submitAssignment(f.first.id, f.offering.id, assignment.id,
    await confirmedSubmissionInput(f.first.id, f.offering.id, assignment.id)), /截止/);
  assert.equal(await db.submissionVersion.count({ where: { offeringId: f.offering.id } }), 1);
});

test('保存后丢回执可跨取消、恢复及归档重试，换人或修改文件不能复用标识', async () => {
  const f = await setup();
  const request = {
    ...await confirmedSubmissionInput(f.first.id, f.offering.id, f.assignment.id, ''),
    uploads: [{ name: 'report.txt', bytes: new Uint8Array([10, 20, 30]) }],
  };
  const saved = await submitAssignment(f.first.id, f.offering.id, f.assignment.id, request);
  let assignment = await changeAssignmentStatus(f.teacher.id, f.offering.id, f.assignment.id,
    { status: 'CANCELLED', cancellationReason: '暂停', expectedRevision: f.assignment.revision });
  assert.equal((await submitAssignment(f.first.id, f.offering.id, assignment.id, request)).id, saved.id);
  await assert.rejects(submitAssignment(f.second.id, f.offering.id, assignment.id, request), /标识已被使用/);
  for (const upload of [
    { name: 'report.txt', bytes: new Uint8Array([10, 20, 31]) },
    { name: 'renamed.txt', bytes: new Uint8Array([10, 20, 30]) },
  ]) await assert.rejects(submitAssignment(f.first.id, f.offering.id, assignment.id,
    { ...request, uploads: [upload] }), /标识已被使用/);
  assignment = await changeAssignmentStatus(f.teacher.id, f.offering.id, assignment.id,
    { status: 'PUBLISHED', expectedRevision: assignment.revision });
  assert.equal((await submitAssignment(f.first.id, f.offering.id, assignment.id, request)).id, saved.id);
  await db.courseOffering.update({ where: { id: f.offering.id }, data: { status: 'ARCHIVED' } });
  assert.equal((await submitAssignment(f.first.id, f.offering.id, assignment.id, request)).id, saved.id);
  await db.courseMember.update({ where: { id: f.firstMember.id }, data: { status: 'INACTIVE' } });
  await assert.rejects(submitAssignment(f.first.id, f.offering.id, assignment.id, request), DomainError);
  assert.equal(await db.submissionVersion.count({ where: { offeringId: f.offering.id } }), 1);
  assert.equal(await db.fileObject.count({ where: { offeringId: f.offering.id } }), 1);
  assert.equal(await db.submissionFile.count({ where: { offeringId: f.offering.id } }), 1);
});

test('取消时教学团队可撤销既有授权，恢复不再开放；学生无全班授权元数据，归档只读', async () => {
  const f = await setup();
  const original = await submitAssignment(f.first.id, f.offering.id, f.assignment.id,
    await confirmedSubmissionInput(f.first.id, f.offering.id, f.assignment.id));
  const other = await submitAssignment(f.newcomer.id, f.offering.id, f.assignment.id,
    await confirmedSubmissionInput(f.newcomer.id, f.offering.id, f.assignment.id));
  let assignment = await updateAssignment(f.teacher.id, f.offering.id, f.assignment.id,
    { ...f.input, dueAt: new Date(Date.now() - 60_000) }, f.assignment.revision);
  const until = new Date(Date.now() + 600_000);
  await setSubmissionCorrectionWindow(f.teacher.id, f.offering.id, assignment.id, original.submissionId, 0, until);
  assignment = await changeAssignmentStatus(f.teacher.id, f.offering.id, assignment.id,
    { status: 'CANCELLED', cancellationReason: '暂停课堂任务', expectedRevision: assignment.revision });
  const staff = await getAssignmentDetail(f.teacher.id, f.offering.id, assignment.id);
  assert.equal(staff.correctionAuthorizations.length, 1);
  assert.equal(staff.correctionAuthorizations[0].latestVersionId, original.id);
  assert.equal((await getAssignmentIndex(f.teacher.id, f.offering.id)).assignments[0].pendingCorrectionCount, 1);
  const student = await getAssignmentDetail(f.newcomer.id, f.offering.id, assignment.id);
  assert.deepEqual(student.correctionAuthorizations, []);
  assert.equal(student.submissionContext!.correctionUntil, null);
  assert.equal(Object.hasOwn((await getAssignmentIndex(f.first.id, f.offering.id)).assignments[0], 'pendingCorrectionCount'), false);
  await assert.rejects(setSubmissionCorrectionWindow(f.teacher.id, f.offering.id, assignment.id, other.submissionId, 0, until), /仍发布/);
  await assert.rejects(setSubmissionCorrectionWindow(f.teacher.id, f.offering.id, assignment.id, original.submissionId, 1, new Date(until.getTime() + 60_000)), /仍发布/);
  await assert.rejects(setSubmissionCorrectionWindow(f.first.id, f.offering.id, assignment.id, original.submissionId, 1, null), DomainError);
  await assert.rejects(setSubmissionCorrectionWindow(f.teacher.id, f.offering.id, assignment.id, original.submissionId, 0, null), /已更新/);
  const unrelated = await createAssignment(f.teacher.id, f.offering.id, { ...f.input, dueAt: new Date(Date.now() - 60_000) });
  await assert.rejects(setSubmissionCorrectionWindow(f.teacher.id, f.offering.id, unrelated.id, original.submissionId, 1, null), /只能为这项作业/);
  await setSubmissionCorrectionWindow(f.teacher.id, f.offering.id, assignment.id, original.submissionId, 1, null);
  assert.deepEqual((await getAssignmentDetail(f.teacher.id, f.offering.id, assignment.id)).correctionAuthorizations, []);
  assert.equal((await getAssignmentIndex(f.teacher.id, f.offering.id)).assignments.find(row => row.id === assignment.id)!.pendingCorrectionCount, 0);
  assignment = await changeAssignmentStatus(f.teacher.id, f.offering.id, assignment.id,
    { status: 'PUBLISHED', expectedRevision: assignment.revision });
  assert.equal((await getAssignmentDetail(f.first.id, f.offering.id, assignment.id)).submissionContext!.canSubmit, false);
  await assert.rejects(submitAssignment(f.first.id, f.offering.id, assignment.id,
    await confirmedSubmissionInput(f.first.id, f.offering.id, assignment.id)), /截止/);
  await setSubmissionCorrectionWindow(f.teacher.id, f.offering.id, assignment.id, original.submissionId, 2, until);
  await changeAssignmentStatus(f.teacher.id, f.offering.id, assignment.id,
    { status: 'CANCELLED', cancellationReason: '取消后归档', expectedRevision: assignment.revision });
  await db.courseOffering.update({ where: { id: f.offering.id }, data: { status: 'ARCHIVED' } });
  const archived = await getAssignmentDetail(f.teacher.id, f.offering.id, assignment.id);
  assert.equal(archived.canReview, false);
  assert.equal(archived.correctionAuthorizations.length, 1);
  await assert.rejects(setSubmissionCorrectionWindow(f.teacher.id, f.offering.id, assignment.id, original.submissionId, 3, null), /进行中课程/);
  assert.equal(await db.submissionCorrectionEvent.count({ where: { submissionId: original.submissionId } }), 3);
});
