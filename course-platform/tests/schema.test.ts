import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';

after(async () => { await db.$disconnect(); });

test('内部观察与外发收件历史保持对象和开课边界，不能事后改写或删除', async () => {
  const f = await fixture(); const other = await fixture();
  const base = { offeringId: f.offering.id, authorUserId: f.teacher.userId, body: '虚构现场观察', requestId: randomUUID() };
  await assert.rejects(db.teachingObservation.create({ data: base }));
  await assert.rejects(db.teachingObservation.create({ data: { ...base, targetMemberId: f.student.id, targetGroupId: f.group.id } }));
  await assert.rejects(db.teachingObservation.create({ data: { ...base, targetMemberId: other.student.id } }));
  const observation = await db.teachingObservation.create({ data: { ...base, targetMemberId: f.student.id } });
  await assert.rejects(db.teachingObservation.update({ where: { id: observation.id }, data: { targetMemberId: f.teacher.id } }));
  await assert.rejects(db.teachingObservation.delete({ where: { id: observation.id } }));
  const feedback = await db.teachingFeedback.create({ data: { ...base, requestId: randomUUID(), targetGroupId: f.group.id } });
  await assert.rejects(db.teachingFeedbackRecipient.create({ data: { offeringId: f.offering.id, feedbackId: feedback.id, memberId: other.student.id } }));
  await db.teachingFeedbackRecipient.create({ data: { offeringId: f.offering.id, feedbackId: feedback.id, memberId: f.student.id } });
  await assert.rejects(db.teachingFeedback.update({ where: { id: feedback.id }, data: { body: '替换已发内容' } }));
  await assert.rejects(db.teachingFeedbackRecipient.delete({ where: { feedbackId_memberId: { feedbackId: feedback.id, memberId: f.student.id } } }));
  assert.equal((await db.teachingObservation.findUniqueOrThrow({ where: { id: observation.id } })).targetMemberId, f.student.id);
});

test('未分组学生仅有现场观察或反馈时，仍不能改写其学生身份及教学作者身份', async () => {
  for (const kind of ['observation', 'personal-feedback', 'group-recipient'] as const) {
    const f = await fixture();
    const base = { offeringId: f.offering.id, authorUserId: f.teacher.userId, body: '仅有文字的虚构现场记录', requestId: randomUUID() };
    if (kind === 'observation') {
      await db.teachingObservation.create({ data: { ...base, targetMemberId: f.student.id } });
    } else {
      const feedback = await db.teachingFeedback.create({ data: {
        ...base,
        ...(kind === 'personal-feedback' ? { targetMemberId: f.student.id } : { targetGroupId: f.group.id }),
      } });
      if (kind === 'group-recipient') await db.teachingFeedbackRecipient.create({ data: { offeringId: f.offering.id, feedbackId: feedback.id, memberId: f.student.id } });
    }
    assert.equal(await db.groupMember.count({ where: { courseMemberId: f.student.id } }), 0);
    assert.equal(await db.submission.count({ where: { courseMemberId: f.student.id } }), 0);
    await assert.rejects(db.courseMember.update({ where: { id: f.student.id }, data: { role: 'TA' } }), /Cannot change role/);
    await assert.rejects(db.courseMember.update({ where: { id: f.teacher.id }, data: { role: 'STUDENT' } }), /Cannot change role/);
    assert.equal((await db.courseMember.findUniqueOrThrow({ where: { id: f.student.id } })).role, 'STUDENT');
  }
});

// The root test runner supplies a freshly migrated, isolated test database.
// These fixtures never connect to another URL or create/drop databases.
async function fixture() {
  const key = randomUUID();
  const user = await db.user.create({ data: { email: `${key}@test.invalid`, name: '虚构规则测试用户' } });
  const teacherUser = await db.user.create({ data: { email: `teacher-${key}@test.invalid`, name: '虚构规则测试教师' } });
  const course = await db.course.create({ data: { slug: key, title: '数据库规则测试' } });
  const term = await db.term.create({ data: { slug: key, name: '测试学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } });
  const offering = await db.courseOffering.create({ data: { courseId: course.id, termId: term.id, title: '测试开课' } });
  const student = await db.courseMember.create({ data: { offeringId: offering.id, userId: user.id, role: 'STUDENT' } });
  const teacher = await db.courseMember.create({ data: { offeringId: offering.id, userId: teacherUser.id, role: 'TEACHER' } });
  const group = await db.group.create({ data: { offeringId: offering.id, name: key } });
  const assignment = await db.assignment.create({ data: { offeringId: offering.id, title: '个人作业', mode: 'INDIVIDUAL' } });
  const groupAssignment = await db.assignment.create({ data: { offeringId: offering.id, title: '小组作业', mode: 'GROUP' } });
  const file = await db.fileObject.create({ data: { offeringId: offering.id, ownerId: user.id, storageKey: key, originalName: 'test.txt', mimeType: 'text/plain', sizeBytes: 1n } });
  return { user, offering, student, teacher, group, assignment, groupAssignment, file };
}
async function draft(f: Awaited<ReturnType<typeof fixture>>) {
  const submission = await db.submission.create({ data: { offeringId: f.offering.id, assignmentId: f.assignment.id, courseMemberId: f.student.id } });
  const version = await db.submissionVersion.create({ data: { offeringId: f.offering.id, submissionId: submission.id, submittedById: f.student.id, version: 1, body: '初稿' } });
  return { submission, version };
}

test('数据库拒绝提交双归属、无归属和与作业模式不符的归属', async () => {
  const f = await fixture();
  const data = { offeringId: f.offering.id, assignmentId: f.assignment.id };
  await assert.rejects(db.submission.create({ data }));
  await assert.rejects(db.submission.create({ data: { ...data, courseMemberId: f.student.id, groupId: f.group.id } }));
  await assert.rejects(db.submission.create({ data: { ...data, groupId: f.group.id } }));
  await assert.rejects(db.submission.create({ data: { ...data, assignmentId: f.groupAssignment.id, courseMemberId: f.student.id } }));
  await db.submission.create({ data: { ...data, courseMemberId: f.student.id } });
  await db.submission.create({ data: { ...data, assignmentId: f.groupAssignment.id, groupId: f.group.id } });
});

test('提交、实际提交者和附件必须属于同一次开课', async () => {
  const f = await fixture(); const other = await fixture();
  await assert.rejects(db.submission.create({ data: { offeringId: f.offering.id, assignmentId: f.assignment.id, courseMemberId: other.student.id } }));
  const { submission, version } = await draft(f);
  await assert.rejects(db.submissionVersion.create({ data: { offeringId: f.offering.id, submissionId: submission.id, submittedById: other.student.id, version: 2, body: '越课' } }));
  await assert.rejects(db.submissionFile.create({ data: { offeringId: f.offering.id, versionId: version.id, fileId: other.file.id } }));
  await db.submissionFile.create({ data: { offeringId: f.offering.id, versionId: version.id, fileId: f.file.id } });
});

test('草稿可以组装，正式封存版本及其快照附件不可增改删', async () => {
  const f = await fixture(); const { version } = await draft(f);
  const participant = { offeringId: f.offering.id, versionId: version.id, courseMemberId: f.student.id };
  const attachment = { offeringId: f.offering.id, versionId: version.id, fileId: f.file.id };
  await db.submissionParticipant.create({ data: participant });
  await db.submissionFile.create({ data: attachment });
  await db.submissionVersion.update({ where: { id: version.id }, data: { body: '完成稿', finalizedAt: new Date() } });
  await assert.rejects(db.submissionVersion.update({ where: { id: version.id }, data: { body: '覆盖' } }));
  await assert.rejects(db.submissionVersion.delete({ where: { id: version.id } }));
  await assert.rejects(db.submissionParticipant.delete({ where: { versionId_courseMemberId: { versionId: version.id, courseMemberId: f.student.id } } }));
  await assert.rejects(db.submissionParticipant.updateMany({ where: { versionId: version.id }, data: { courseMemberId: f.teacher.id } }));
  await assert.rejects(db.submissionParticipant.create({ data: { ...participant, courseMemberId: f.teacher.id } }));
  await assert.rejects(db.submissionFile.delete({ where: { versionId_fileId: { versionId: version.id, fileId: f.file.id } } }));
  await assert.rejects(db.submissionFile.updateMany({ where: { versionId: version.id }, data: { offeringId: f.offering.id } }));
  await assert.rejects(db.fileObject.update({ where: { id: f.file.id }, data: { bytes: Buffer.from('silently replaced') } }));
  await assert.rejects(db.fileObject.update({ where: { id: f.file.id }, data: { originalName: 'different.pdf' } }));
  await assert.rejects(db.fileObject.delete({ where: { id: f.file.id } }));
  const extra = await db.fileObject.create({ data: { offeringId: f.offering.id, ownerId: f.user.id, storageKey: randomUUID(), originalName: 'extra.txt', mimeType: 'text/plain', sizeBytes: 1n } });
  await assert.rejects(db.submissionFile.create({ data: { ...attachment, fileId: extra.id } }));
  assert.equal((await db.submissionVersion.findUniqueOrThrow({ where: { id: version.id } })).body, '完成稿');
});

test('评阅要求封存，成绩来源须对应作业和学生快照，历史不可改删', async () => {
  const f = await fixture(); const { version } = await draft(f);
  const reviewData = { offeringId: f.offering.id, versionId: version.id, reviewerId: f.teacher.id, body: '测试评阅' };
  await assert.rejects(db.review.create({ data: reviewData }));
  await db.submissionVersion.update({ where: { id: version.id }, data: { finalizedAt: new Date() } });
  await assert.rejects(db.review.create({ data: { ...reviewData, reviewerId: f.student.id } }));
  const review = await db.review.create({ data: reviewData });
  const gradeData = { offeringId: f.offering.id, assignmentId: f.assignment.id, courseMemberId: f.student.id, score: '80', reviewId: review.id, updatedById: f.teacher.id };
  // A matching personal owner alone is insufficient: the formal participant snapshot is required.
  await assert.rejects(db.gradeRecord.create({ data: gradeData }));
  const another = await db.submissionVersion.create({ data: { offeringId: f.offering.id, submissionId: version.submissionId, submittedById: f.student.id, version: 2, body: '含快照版本' } });
  await db.submissionParticipant.create({ data: { offeringId: f.offering.id, versionId: another.id, courseMemberId: f.student.id } });
  await db.submissionVersion.update({ where: { id: another.id }, data: { finalizedAt: new Date() } });
  const source = await db.review.create({ data: { ...reviewData, versionId: another.id } });
  const valid = { ...gradeData, reviewId: source.id };
  await assert.rejects(db.gradeRecord.create({ data: { ...valid, assignmentId: f.groupAssignment.id } }));
  await assert.rejects(db.gradeRecord.create({ data: { ...valid, updatedById: f.student.id } }));
  await assert.rejects(db.gradeRecord.create({ data: { ...valid, courseMemberId: f.teacher.id } }));
  await assert.rejects(db.gradeRecord.create({ data: { ...valid, status: 'PUBLISHED' } }));
  const grade = await db.gradeRecord.create({ data: { ...valid, status: 'PUBLISHED', publishedAt: new Date() } });
  const history = await db.gradeHistory.create({ data: { offeringId: f.offering.id, gradeRecordId: grade.id, actorId: f.teacher.id, score: '80', previousScore: null, status: 'PUBLISHED', reason: '虚构测试首次发布' } });
  await assert.rejects(db.gradeHistory.update({ where: { id: history.id }, data: { reason: '覆盖原因' } }));
  await assert.rejects(db.gradeHistory.delete({ where: { id: history.id } }));
});

test('评阅来源与署名永久固定，已有评阅或教学笔记的成员角色不可改写', async () => {
  const f = await fixture(); const { version } = await draft(f);
  await db.submissionParticipant.create({ data: { offeringId: f.offering.id, versionId: version.id, courseMemberId: f.student.id } });
  await db.submissionVersion.update({ where: { id: version.id }, data: { finalizedAt: new Date() } });
  const review = await db.review.create({ data: { offeringId: f.offering.id, versionId: version.id, reviewerId: f.teacher.id, body: '初始评阅' } });
  const another = await db.submissionVersion.create({ data: { offeringId: f.offering.id, submissionId: version.submissionId, submittedById: f.student.id, version: 2, body: '另一版本', finalizedAt: new Date() } });
  await assert.rejects(db.review.update({ where: { id: review.id }, data: { versionId: another.id } }));
  // Comment changes remain permitted; the source/attribution guard is deliberately narrow.
  await db.review.update({ where: { id: review.id }, data: { body: '补充评语' } });
  await assert.rejects(db.courseMember.update({ where: { id: f.teacher.id }, data: { role: 'STUDENT' } }));
  const other = await fixture();
  await db.teachingNote.create({ data: { offeringId: other.offering.id, courseMemberId: other.teacher.id, title: '教学笔记', body: '测试作者保护' } });
  await assert.rejects(db.courseMember.update({ where: { id: other.teacher.id }, data: { role: 'TA' } }));
});

test('改分者与历史操作者的教学身份不能在事后被改写', async () => {
  const f = await fixture(); const { version } = await draft(f);
  await db.submissionParticipant.create({ data: { offeringId: f.offering.id, versionId: version.id, courseMemberId: f.student.id } });
  await db.submissionVersion.update({ where: { id: version.id }, data: { finalizedAt: new Date() } });
  const review = await db.review.create({ data: { offeringId: f.offering.id, versionId: version.id, reviewerId: f.teacher.id, body: '来源' } });
  async function newStaff() {
    const key = randomUUID();
    const user = await db.user.create({ data: { email: `${key}@test.invalid`, name: '虚构改分教师' } });
    return db.courseMember.create({ data: { offeringId: f.offering.id, userId: user.id, role: 'TA' } });
  }
  const updater = await newStaff(); const historian = await newStaff();
  const grade = await db.gradeRecord.create({ data: { offeringId: f.offering.id, assignmentId: f.assignment.id, courseMemberId: f.student.id, score: '70', reviewId: review.id, updatedById: updater.id } });
  await db.gradeHistory.create({ data: { offeringId: f.offering.id, gradeRecordId: grade.id, actorId: historian.id, previousScore: null, score: '70', status: 'DRAFT', reason: '虚构历史记录' } });
  await assert.rejects(db.courseMember.update({ where: { id: updater.id }, data: { role: 'STUDENT' } }));
  await assert.rejects(db.courseMember.update({ where: { id: historian.id }, data: { role: 'STUDENT' } }));
  // Grade references cannot be invalidated by moving a review after creation either.
  const other = await fixture(); const otherDraft = await draft(other);
  await db.submissionVersion.update({ where: { id: otherDraft.version.id }, data: { finalizedAt: new Date() } });
  await assert.rejects(db.review.update({ where: { id: review.id }, data: { offeringId: other.offering.id, versionId: otherDraft.version.id, reviewerId: other.teacher.id } }));
});

async function reviewStaff(f: Awaited<ReturnType<typeof fixture>>, status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') {
  const key = randomUUID();
  const user = await db.user.create({ data: { email: `review-${key}@test.invalid`, name: '虚构评阅助教' } });
  return db.courseMember.create({ data: { offeringId: f.offering.id, userId: user.id, role: 'TA', status } });
}

test('评阅状态只接受封存版本与本期在岗教学署名，完成状态不能匿名', async () => {
  const f = await fixture(); const { version } = await draft(f);
  const data = { offeringId: f.offering.id, versionId: version.id, state: 'PENDING' as const, revision: 1 };
  await assert.rejects(db.submissionVersionReview.create({ data }));
  assert.equal(await db.submissionVersionReview.count({ where: { versionId: version.id } }), 0);
  await db.submissionVersion.update({ where: { id: version.id }, data: { finalizedAt: new Date() } });
  await assert.rejects(db.submissionVersionReview.create({ data: { ...data, state: 'COMPLETED' } }));
  await assert.rejects(db.submissionVersionReview.create({ data: { ...data, updatedById: f.student.id } }));
  const inactive = await reviewStaff(f, 'INACTIVE');
  const active = await reviewStaff(f);
  const other = await fixture();
  await assert.rejects(db.submissionVersionReview.create({ data: { ...data, updatedById: inactive.id } }));
  await assert.rejects(db.submissionVersionReview.create({ data: { ...data, updatedById: other.teacher.id } }));
  // Initial pending progress has no teacher signature; explicit completion does.
  await db.submissionVersionReview.create({ data });
  const where = { versionId: version.id };
  await assert.rejects(db.submissionVersionReview.update({ where, data: { state: 'COMPLETED' } }));
  await assert.rejects(db.submissionVersionReview.update({ where, data: { updatedById: f.student.id } }));
  await assert.rejects(db.submissionVersionReview.update({ where, data: { updatedById: inactive.id } }));
  await assert.rejects(db.submissionVersionReview.update({ where, data: { updatedById: other.teacher.id } }));
  const completed = await db.submissionVersionReview.update({ where, data: { state: 'COMPLETED', revision: 2, updatedById: active.id } });
  assert.equal(completed.state, 'COMPLETED');
  assert.equal(completed.updatedById, active.id);
  await assert.rejects(db.submissionVersionReview.update({ where, data: { updatedById: null } }));
  const reopened = await db.submissionVersionReview.update({ where, data: { state: 'PENDING', revision: 3, updatedById: f.teacher.id } });
  assert.equal(reopened.updatedById, f.teacher.id);
});

test('评阅状态永久绑定提交版本与开课，即使目标也是有效封存版本也不能迁移', async () => {
  const f = await fixture(); const { version } = await draft(f);
  await db.submissionVersion.update({ where: { id: version.id }, data: { finalizedAt: new Date() } });
  const another = await db.submissionVersion.create({ data: {
    offeringId: f.offering.id, submissionId: version.submissionId, submittedById: f.student.id,
    version: 2, body: '另一封存版本', finalizedAt: new Date(),
  } });
  const other = await fixture(); const otherDraft = await draft(other);
  await db.submissionVersion.update({ where: { id: otherDraft.version.id }, data: { finalizedAt: new Date() } });
  // No event exists yet, so a rejection cannot merely come from its immutable FK cascade.
  await db.submissionVersionReview.create({ data: { versionId: version.id, offeringId: f.offering.id } });
  const where = { versionId: version.id };
  await assert.rejects(db.submissionVersionReview.update({ where, data: { versionId: another.id } }));
  await assert.rejects(db.submissionVersionReview.update({ where, data: { versionId: otherDraft.version.id, offeringId: other.offering.id } }));
  assert.equal((await db.submissionVersionReview.findUniqueOrThrow({ where })).offeringId, f.offering.id);
  assert.equal(await db.submissionVersionReview.count({ where: { versionId: { in: [another.id, otherDraft.version.id] } } }), 0);
});

test('评阅审计事件必须匹配当前状态的版本号、状态和署名，写入后不可改删', async () => {
  const f = await fixture(); const { version } = await draft(f);
  await db.submissionVersion.update({ where: { id: version.id }, data: { finalizedAt: new Date() } });
  const data = { versionId: version.id, offeringId: f.offering.id, revision: 2, state: 'COMPLETED' as const, actorId: f.teacher.id };
  const alternate = await reviewStaff(f);
  await db.submissionVersionReview.create({ data: {
    versionId: version.id, offeringId: f.offering.id, revision: 2, state: 'COMPLETED', updatedById: f.teacher.id,
  } });
  // Use an empty event history so uniqueness cannot mask the consistency guard.
  await assert.rejects(db.submissionReviewEvent.create({ data: { ...data, revision: 1 } }));
  await assert.rejects(db.submissionReviewEvent.create({ data: { ...data, revision: 3 } }));
  await assert.rejects(db.submissionReviewEvent.create({ data: { ...data, state: 'PENDING' } }));
  await assert.rejects(db.submissionReviewEvent.create({ data: { ...data, actorId: alternate.id } }));
  await assert.rejects(db.submissionReviewEvent.create({ data: { ...data, actorId: null } }));
  assert.equal(await db.submissionReviewEvent.count({ where: { versionId: version.id } }), 0);
  const event = await db.submissionReviewEvent.create({ data });
  await assert.rejects(db.submissionReviewEvent.update({ where: { id: event.id }, data: { actorId: alternate.id } }));
  await assert.rejects(db.submissionReviewEvent.update({ where: { id: event.id }, data: { state: 'PENDING' } }));
  await assert.rejects(db.submissionReviewEvent.delete({ where: { id: event.id } }));
  assert.equal((await db.submissionReviewEvent.findUniqueOrThrow({ where: { id: event.id } })).actorId, f.teacher.id);
});

test('没有评论的评阅操作者也保留角色，当前状态换人后仅历史事件仍保护原署名', async () => {
  const f = await fixture(); const { version } = await draft(f);
  const successor = await reviewStaff(f);
  await db.submissionVersion.update({ where: { id: version.id }, data: { finalizedAt: new Date() } });
  await db.submissionVersionReview.create({ data: {
    versionId: version.id, offeringId: f.offering.id, state: 'COMPLETED', revision: 1, updatedById: f.teacher.id,
  } });
  assert.equal(await db.review.count({ where: { reviewerId: f.teacher.id } }), 0);
  assert.equal(await db.submissionReviewEvent.count({ where: { actorId: f.teacher.id } }), 0);
  // At this point only SubmissionVersionReview refers to this teacher.
  await assert.rejects(db.courseMember.update({ where: { id: f.teacher.id }, data: { role: 'TA' } }));
  await db.submissionReviewEvent.create({ data: {
    versionId: version.id, offeringId: f.offering.id, state: 'COMPLETED', revision: 1, actorId: f.teacher.id,
  } });
  await db.submissionVersionReview.update({ where: { versionId: version.id }, data: {
    state: 'PENDING', revision: 2, updatedById: successor.id,
  } });
  await db.submissionReviewEvent.create({ data: {
    versionId: version.id, offeringId: f.offering.id, state: 'PENDING', revision: 2, actorId: successor.id,
  } });
  assert.equal(await db.submissionVersionReview.count({ where: { updatedById: f.teacher.id } }), 0);
  assert.equal(await db.submissionReviewEvent.count({ where: { actorId: f.teacher.id } }), 1);
  // The former actor is now referenced only by the immutable event history.
  await assert.rejects(db.courseMember.update({ where: { id: f.teacher.id }, data: { role: 'TA' } }));
  assert.equal((await db.courseMember.findUniqueOrThrow({ where: { id: f.teacher.id } })).role, 'TEACHER');
});
