import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { DomainError, moveStudentToGroup } from '../src/lib/management';
import { MAX_SUBMISSION_FILE_BYTES } from '../src/lib/submission-contract';
import { createAssignment, getSubmissionAttachment, getSubmissionVersion, setSubmissionCorrectionWindow, SubmissionConflictError, submitAssignment, updateAssignment, type AssignmentInput } from '../src/lib/teaching';
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

test('同组不同请求并发交附件仅一份封存，失败请求不遗留文件，同请求并发重试返回原回执', async () => {
  const f = await setup();
  const { offering, assignment } = f;
  const requests = await Promise.all([f.first, f.second].map(async (user, index) => ({
    ...await confirmedSubmissionInput(user.id, offering.id, assignment.id, ''),
    uploads: [{ name: 'data.csv', bytes: new Uint8Array([index + 1]) }],
  })));
  const settled = await Promise.allSettled([f.first, f.second].map((user, index) =>
    submitAssignment(user.id, offering.id, assignment.id, requests[index])));
  const winner = settled.findIndex(outcome => outcome.status === 'fulfilled');
  assert.ok(winner >= 0);
  const lost = settled[1 - winner];
  assert.ok(lost.status === 'rejected' && lost.reason instanceof SubmissionConflictError);
  const author = [f.first, f.second][winner];
  const request = requests[winner];
  const retries = await Promise.all([
    submitAssignment(author.id, offering.id, assignment.id, request),
    submitAssignment(author.id, offering.id, assignment.id, request),
  ]);
  assert.equal(retries[0].id, request.requestId);
  assert.equal(retries[1].id, request.requestId);
  assert.equal(await db.submissionVersion.count({ where: { offeringId: offering.id } }), 1);
  assert.equal(await db.fileObject.count({ where: { offeringId: offering.id } }), 1);
  assert.equal(await db.submissionFile.count({ where: { offeringId: offering.id } }), 1);
});

test('附件以开课、作业、版本与文件组合授权，改组后保留原参与成果但不能读原组后续附件', async () => {
  const f = await setup();
  const { offering, assignment } = f;
  const make = async (actor: string, title: string) => submitAssignment(actor, offering.id, assignment.id, {
    ...await confirmedSubmissionInput(actor, offering.id, assignment.id, ''),
    uploads: [{ name: title, bytes: new Uint8Array([1]) }],
  });
  const original = await make(f.first.id, '当时的材料.txt');
  const originalFile = (await getSubmissionVersion(f.first.id, offering.id, original.id)).version.attachments[0];
  await moveStudentToGroup(f.teacher.id, offering.id, f.b.id, f.firstMember.id);
  await moveStudentToGroup(f.teacher.id, offering.id, f.a.id, f.newcomerMember.id);
  const afterMove = await make(f.second.id, '离组之后的材料.txt');
  const nextFile = (await getSubmissionVersion(f.second.id, offering.id, afterMove.id)).version.attachments[0];
  const otherAssignment = await createAssignment(f.teacher.id, offering.id, { ...f.input, title: '另一个作业' });
  assert.ok(await getSubmissionAttachment(f.first.id, offering.id, assignment.id, original.id, originalFile.id));
  assert.ok(await getSubmissionAttachment(f.newcomer.id, offering.id, assignment.id, original.id, originalFile.id));
  assert.equal(await getSubmissionAttachment(f.first.id, offering.id, assignment.id, afterMove.id, nextFile.id), null);
  assert.equal(await getSubmissionAttachment(f.second.id, offering.id, assignment.id, afterMove.id, originalFile.id), null);
  assert.equal(await getSubmissionAttachment(f.second.id, offering.id, otherAssignment.id, original.id, originalFile.id), null);
  assert.ok(!(await getSubmissionVersion(f.newcomer.id, offering.id, original.id)).version.participants.some(member => member.id === f.newcomerMember.id));
  await assert.rejects(submitAssignment(f.first.id, offering.id, assignment.id, {
    ...await confirmedSubmissionInput(f.first.id, offering.id, assignment.id, ''),
    retainedFileIds: [originalFile.id],
  }), /只能保留本次更正所依据/);
  assert.equal(await db.submission.count({ where: { assignmentId: assignment.id } }), 1);
});

test('保留附件与新增附件共同计入上限，撤销更正后的原请求仍可取回回执', async () => {
  const f = await setup();
  const { offering, assignment } = f;
  const original = await submitAssignment(f.first.id, offering.id, assignment.id, {
    ...await confirmedSubmissionInput(f.first.id, offering.id, assignment.id, ''),
    uploads: [{ name: '材料.bin', bytes: new Uint8Array(MAX_SUBMISSION_FILE_BYTES) }],
  });
  const originalFile = (await getSubmissionVersion(f.first.id, offering.id, original.id)).version.attachments[0];
  const overLimit = {
    ...await confirmedSubmissionInput(f.first.id, offering.id, assignment.id, ''),
    retainedFileIds: [originalFile.id], uploads: [{ name: '多一个字节.txt', bytes: new Uint8Array([1]) }],
  };
  await assert.rejects(submitAssignment(f.first.id, offering.id, assignment.id, overLimit), /合计不能超过/);
  assert.equal(await db.fileObject.count({ where: { offeringId: offering.id } }), 1);
  await updateAssignment(f.teacher.id, offering.id, assignment.id, { ...f.input, dueAt: new Date(Date.now() - 60_000) }, assignment.revision);
  await setSubmissionCorrectionWindow(f.teacher.id, offering.id, assignment.id, original.submissionId, 0, new Date(Date.now() + 120_000));
  const allowed = {
    ...await confirmedSubmissionInput(f.first.id, offering.id, assignment.id, '更正说明'),
    retainedFileIds: [originalFile.id],
  };
  const corrected = await submitAssignment(f.first.id, offering.id, assignment.id, allowed);
  const stale = await confirmedSubmissionInput(f.first.id, offering.id, assignment.id, '尚未发出的更正');
  await setSubmissionCorrectionWindow(f.teacher.id, offering.id, assignment.id, original.submissionId, 1, null);
  assert.equal((await submitAssignment(f.first.id, offering.id, assignment.id, allowed)).id, corrected.id);
  await assert.rejects(submitAssignment(f.first.id, offering.id, assignment.id, stale), DomainError);
  assert.equal(await db.submissionVersion.count({ where: { offeringId: offering.id } }), 2);
  assert.equal(await db.fileObject.count({ where: { offeringId: offering.id } }), 1);
});
