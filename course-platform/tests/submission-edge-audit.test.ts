import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { DomainError, moveStudentToGroup } from '../src/lib/management';
import { MAX_FORMAL_SUBMISSION_FILE_BYTES, MAX_SUBMISSION_FILE_BYTES, SUBMISSION_CHUNK_BYTES } from '../src/lib/submission-contract';
import { streamStoredFile } from '../src/lib/stored-file';
import { discardSubmissionUpload, saveSubmissionChunk, SubmissionUploadUnavailableError } from '../src/lib/submission-upload-store';
import { createAssignment, getSubmissionAttachment, getSubmissionVersion, requireSubmissionUploadAccess, setSubmissionCorrectionWindow, SubmissionBlockedError, SubmissionConflictError, submitAssignment, updateAssignment, type AssignmentInput } from '../src/lib/teaching';
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
  const declaredSize = MAX_FORMAL_SUBMISSION_FILE_BYTES - MAX_SUBMISSION_FILE_BYTES + 1;
  const stagedId = randomUUID();
  const staged = await db.fileObject.create({
    data: {
      id: stagedId, offeringId: offering.id, ownerId: f.first.id, storageKey: randomUUID(),
      originalName: '大附件.bin', mimeType: 'application/octet-stream', sizeBytes: declaredSize, chunked: true,
      submissionUpload: { create: {
        assignment: { connect: { id: assignment.id } },
        receivedBytes: declaredSize, digest: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000),
      } },
    },
  });
  const overLimit = {
    ...await confirmedSubmissionInput(f.first.id, offering.id, assignment.id, ''),
    retainedFileIds: [originalFile.id], stagedFileIds: [staged.id],
  };
  await assert.rejects(submitAssignment(f.first.id, offering.id, assignment.id, overLimit), /合计不能超过/);
  await db.fileObject.delete({ where: { id: staged.id } });
  assert.equal(await db.fileObject.count({ where: { offeringId: offering.id } }), 1);
  await updateAssignment(f.teacher.id, offering.id, assignment.id, { ...f.input, dueAt: new Date(Date.now() - 60_000) }, assignment.revision);
  await assert.rejects(requireSubmissionUploadAccess(f.first.id, offering.id, assignment.id), /已超过作业截止时间/);
  await setSubmissionCorrectionWindow(f.teacher.id, offering.id, assignment.id, original.submissionId, 0, new Date(Date.now() + 120_000));
  await requireSubmissionUploadAccess(f.first.id, offering.id, assignment.id);
  await assert.rejects(requireSubmissionUploadAccess(f.newcomer.id, offering.id, assignment.id), /已超过作业截止时间/);
  const allowed = {
    ...await confirmedSubmissionInput(f.first.id, offering.id, assignment.id, '更正说明'),
    retainedFileIds: [originalFile.id],
  };
  const corrected = await submitAssignment(f.first.id, offering.id, assignment.id, allowed);
  const stale = await confirmedSubmissionInput(f.first.id, offering.id, assignment.id, '尚未发出的更正');
  await setSubmissionCorrectionWindow(f.teacher.id, offering.id, assignment.id, original.submissionId, 1, null);
  await assert.rejects(requireSubmissionUploadAccess(f.first.id, offering.id, assignment.id), /已超过作业截止时间/);
  assert.equal((await submitAssignment(f.first.id, offering.id, assignment.id, allowed)).id, corrected.id);
  await assert.rejects(submitAssignment(f.first.id, offering.id, assignment.id, stale), DomainError);
  assert.equal(await db.submissionVersion.count({ where: { offeringId: offering.id } }), 2);
  assert.equal(await db.fileObject.count({ where: { offeringId: offering.id } }), 1);
});

test('自然截止时返回只读上下文，完整暂存仍可释放，已封存请求可在截止和归档后取回回执', async t => {
  const f = await setup();
  const { first, newcomer, offering } = f;
  const deadline = Date.now() + 60_000;
  const assignment = await updateAssignment(f.teacher.id, offering.id, f.assignment.id,
    { ...f.input, dueAt: new Date(deadline) }, f.assignment.revision);
  t.mock.timers.enable({ apis: ['Date'], now: deadline - 1 });

  const completedBytes = Uint8Array.of(4, 5, 6);
  const [submittedId, unsubmittedId] = [randomUUID(), randomUUID()];
  for (const [student, fileId] of [[first, submittedId], [newcomer, unsubmittedId]] as const) {
    await saveSubmissionChunk(student.id, offering.id, assignment.id, fileId,
      { name: '成果材料.txt', size: completedBytes.length, index: 0, bytes: completedBytes });
  }
  const savedRequest = {
    ...await confirmedSubmissionInput(first.id, offering.id, assignment.id, '截止前保存的成果'), stagedFileIds: [submittedId],
  };
  const saved = await submitAssignment(first.id, offering.id, assignment.id, savedRequest);

  const inlineBytes = Uint8Array.of(9);
  // The service copies inline bytes into the file row after its first deadline checks.
  Object.defineProperty(inlineBytes, Symbol.iterator, { value: () => {
    t.mock.timers.setTime(deadline);
    return inlineBytes.values();
  } });
  const pendingRequest = {
    ...await confirmedSubmissionInput(newcomer.id, offering.id, assignment.id, '截止时尚未封存的草稿'),
    stagedFileIds: [unsubmittedId], uploads: [{ name: '补充.txt', bytes: inlineBytes }],
  };
  const submitPending = () => submitAssignment(newcomer.id, offering.id, assignment.id, pendingRequest);
  const blockedBy = (reason: RegExp) => (error: unknown) => {
    assert.ok(error instanceof SubmissionBlockedError);
    assert.equal(error.submissionContext.canSubmit, false);
    assert.match(error.submissionContext.blockedReason, reason);
    assert.equal(error.submissionContext.confirmation.assignmentRevision, pendingRequest.expectedAssignmentRevision);
    assert.equal(error.submissionContext.confirmation.latestSubmissionToken, pendingRequest.expectedLatestSubmissionToken);
    assert.equal(error.submissionContext.confirmation.groupId, pendingRequest.expectedGroupId);
    assert.equal(error.submissionContext.latestSubmission, null);
    return true;
  };
  await assert.rejects(submitPending(), blockedBy(/超过作业截止时间/));
  assert.equal(Date.now(), deadline);
  await assert.rejects(submitPending(), blockedBy(/超过作业截止时间/));
  assert.equal((await submitAssignment(first.id, offering.id, assignment.id, savedRequest)).id, saved.id);

  await db.courseOffering.update({ where: { id: offering.id }, data: { status: 'ARCHIVED' } });
  await assert.rejects(submitPending(), blockedBy(/课程已归档/));
  assert.equal((await submitAssignment(first.id, offering.id, assignment.id, savedRequest)).id, saved.id);
  assert.equal(await db.submissionVersion.findUnique({ where: { id: pendingRequest.requestId } }), null);
  assert.equal(await db.submission.count({ where: { assignmentId: assignment.id } }), 1);
  assert.equal(await db.fileObject.count({ where: { offeringId: offering.id } }), 2);
  assert.equal((await db.submissionUpload.findUniqueOrThrow({ where: { fileId: unsubmittedId } })).consumedAt, null);

  await discardSubmissionUpload(newcomer.id, offering.id, assignment.id, unsubmittedId);
  assert.equal(await db.fileObject.findUnique({ where: { id: unsubmittedId } }), null);
  assert.ok(await getSubmissionAttachment(first.id, offering.id, assignment.id, saved.id, submittedId));
});

test('分块附件在正式提交前不可读，断点重试、更正和旧版回执保留原内容', async () => {
  const f = await setup();
  const { offering, assignment } = f;
  const size = SUBMISSION_CHUNK_BYTES + 5;
  const name = '原型报告.pdf';
  const id = randomUUID();
  const first = new Uint8Array(SUBMISSION_CHUNK_BYTES).fill(8);
  const last = Uint8Array.of(9, 3, 6, 4, 1);
  const put = (index: number, bytes: Uint8Array, fileId = id, userId = f.first.id) =>
    saveSubmissionChunk(userId, offering.id, assignment.id, fileId, { name, size, index, bytes });
  const request = { ...await confirmedSubmissionInput(f.first.id, offering.id, assignment.id, ''), stagedFileIds: [id] };
  await requireSubmissionUploadAccess(f.first.id, offering.id, assignment.id);
  await assert.rejects(requireSubmissionUploadAccess(f.teacher.id, offering.id, assignment.id), DomainError);
  await assert.rejects(put(1, last), DomainError);
  const expiredId = randomUUID();
  await put(0, first, expiredId);
  await db.submissionUpload.update({ where: { fileId: expiredId }, data: { expiresAt: new Date(0) } });
  await assert.rejects(put(1, last, expiredId), SubmissionUploadUnavailableError);
  assert.equal((await put(0, first)).receivedBytes, first.length);
  assert.equal(await db.fileObject.count({ where: { id: expiredId } }), 0);
  assert.equal(await db.fileObjectChunk.count({ where: { fileId: expiredId } }), 0);
  assert.equal((await put(0, first)).receivedBytes, first.length);
  await assert.rejects(put(0, new Uint8Array(first.length)), DomainError);
  await assert.rejects(put(1, last, id, f.second.id), DomainError);
  await assert.rejects(submitAssignment(f.first.id, offering.id, assignment.id, request), SubmissionUploadUnavailableError);
  assert.equal(await getSubmissionAttachment(f.teacher.id, offering.id, assignment.id, request.requestId, id), null);
  assert.equal((await put(1, last)).receivedBytes, size);
  await assert.rejects(submitAssignment(f.second.id, offering.id, assignment.id, {
    ...await confirmedSubmissionInput(f.second.id, offering.id, assignment.id, ''), stagedFileIds: [id],
  }), SubmissionUploadUnavailableError);
  const [version, replay] = await Promise.all([
    submitAssignment(f.first.id, offering.id, assignment.id, request),
    submitAssignment(f.first.id, offering.id, assignment.id, request),
  ]);
  assert.equal(version.id, request.requestId);
  assert.equal(replay.id, version.id);
  await discardSubmissionUpload(f.first.id, offering.id, assignment.id, id);
  assert.equal((await submitAssignment(f.first.id, offering.id, assignment.id, request)).id, version.id);
  assert.equal(await db.submissionFile.count({ where: { fileId: id } }), 1);
  const original = await getSubmissionAttachment(f.teacher.id, offering.id, assignment.id, version.id, id);
  assert.ok(original);
  assert.equal(original.name, name);
  const bytes = new Uint8Array(await new Response(streamStoredFile(original)).arrayBuffer());
  assert.deepEqual(bytes.subarray(0, first.length), first);
  assert.deepEqual(bytes.subarray(first.length), last);
  assert.equal(await getSubmissionAttachment(f.newcomer.id, offering.id, assignment.id, version.id, id), null);
  await assert.rejects(db.fileObjectChunk.update({ where: { fileId_index: { fileId: id, index: 0 } }, data: { bytes: new Uint8Array(first.length) } }));
  const correction = await submitAssignment(f.second.id, offering.id, assignment.id, {
    ...await confirmedSubmissionInput(f.second.id, offering.id, assignment.id, '补上测试说明'), retainedFileIds: [id],
  });
  assert.equal(correction.version, 2);
  assert.ok(await getSubmissionAttachment(f.first.id, offering.id, assignment.id, correction.id, id));
  await updateAssignment(f.teacher.id, offering.id, assignment.id, { ...f.input, status: 'CANCELLED', cancellationReason: '结束本次练习' }, assignment.revision);
  assert.equal((await submitAssignment(f.first.id, offering.id, assignment.id, request)).id, version.id);
  assert.equal(await db.submissionVersion.count({ where: { offeringId: offering.id } }), 2);
});

test('换件释放本人作业暂存的额度，迟到的首块不会恢复已移除的附件', async () => {
  const f = await setup();
  const { offering, assignment, first, second } = f;
  const other = await createAssignment(f.teacher.id, offering.id, { ...f.input, title: '第二项作业' });
  const [removedId, keptId, replacementId, interruptedId] = Array.from({ length: 4 }, () => randomUUID());
  const bytes = new Uint8Array(SUBMISSION_CHUNK_BYTES).fill(5);
  const put = (assignmentId: string, fileId: string, size = MAX_FORMAL_SUBMISSION_FILE_BYTES) =>
    saveSubmissionChunk(first.id, offering.id, assignmentId, fileId, { name: '测试原型视频.mp4', size, index: 0, bytes });
  await put(assignment.id, removedId);
  await put(other.id, keptId);
  const replacement = () => put(assignment.id, replacementId, 16 * SUBMISSION_CHUNK_BYTES);
  await assert.rejects(replacement(), /暂存附件已达上限/);

  await discardSubmissionUpload(second.id, offering.id, assignment.id, removedId);
  await discardSubmissionUpload(first.id, offering.id, other.id, removedId);
  assert.equal((await put(assignment.id, removedId)).receivedBytes, bytes.length);
  await assert.rejects(replacement(), /暂存附件已达上限/);

  await discardSubmissionUpload(first.id, offering.id, assignment.id, removedId);
  await discardSubmissionUpload(first.id, offering.id, assignment.id, removedId);
  assert.equal(await db.fileObject.count({ where: { id: removedId } }), 0);
  assert.equal(await db.fileObjectChunk.count({ where: { fileId: removedId } }), 0);
  assert.equal((await replacement()).receivedBytes, bytes.length);
  assert.equal((await put(other.id, keptId)).receivedBytes, bytes.length);
  await assert.rejects(put(assignment.id, removedId), SubmissionUploadUnavailableError);

  await discardSubmissionUpload(first.id, offering.id, assignment.id, interruptedId);
  await assert.rejects(put(assignment.id, interruptedId, bytes.length), SubmissionUploadUnavailableError);
  assert.equal(await db.fileObject.count({ where: { id: interruptedId } }), 0);

  const racingId = randomUUID();
  await put(assignment.id, racingId, bytes.length);
  const request = { ...await confirmedSubmissionInput(first.id, offering.id, assignment.id, ''), stagedFileIds: [racingId] };
  const [submitted, discarded] = await Promise.allSettled([
    submitAssignment(first.id, offering.id, assignment.id, request),
    discardSubmissionUpload(first.id, offering.id, assignment.id, racingId),
  ]);
  assert.equal(discarded.status, 'fulfilled');
  if (submitted.status === 'fulfilled') {
    const file = await getSubmissionAttachment(first.id, offering.id, assignment.id, submitted.value.id, racingId);
    assert.ok(file);
    assert.deepEqual(new Uint8Array(await new Response(streamStoredFile(file)).arrayBuffer()), bytes);
  } else {
    assert.ok(submitted.reason instanceof SubmissionUploadUnavailableError);
    assert.equal(await db.fileObject.count({ where: { id: racingId } }), 0);
    assert.equal(await db.submissionVersion.findUnique({ where: { id: request.requestId } }), null);
  }
});
