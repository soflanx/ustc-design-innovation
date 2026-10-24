import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';

after(async () => { await db.$disconnect(); });

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
