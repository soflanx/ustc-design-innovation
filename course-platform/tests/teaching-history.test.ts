import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createCourseSubpage } from '../src/lib/course-subpages';
import { db } from '../src/lib/db';
import { DomainError, moveStudentToGroup } from '../src/lib/management';
import { addFeedback, createAssignment, getAssignmentDetail, submitAssignment } from '../src/lib/teaching';
import { getTeachingHistory, listTeachingMembers, teachingHistoryItems, teachingHistoryOverview } from '../src/lib/teaching-history';
import { recordTeachingObservation, sendTeachingFeedback } from '../src/lib/teaching-observations';
import { getTeachingLessonReturn, getTeachingResultSource } from '../src/lib/teaching-result-source';
import { confirmedSubmissionInput } from './submission-fixture';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(() => db.$disconnect());

test('学生和小组各自回看真实课次、原版本评语及当时收到的指导', async () => {
  const key = randomUUID();
  const { id: offeringId } = await db.courseOffering.create({ data: {
    course: { create: { slug: key, title: '回顾测试' } },
    term: { create: { slug: key, name: '测试学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } },
    title: '本期回顾测试', status: 'ACTIVE',
  } });
  const member = (role: 'TEACHER' | 'TA' | 'STUDENT', name: string) => db.courseMember.create({ data: {
    role, offering: { connect: { id: offeringId } },
    user: { create: { name, email: `${randomUUID()}@test.invalid` } },
  } });
  const [teacher, ta, student, oldPartner, newPartner, ungrouped] = await Promise.all([
    member('TEACHER', '测试教师'), member('TA', '测试助教'),
    member('STUDENT', '调组学生'), member('STUDENT', '旧组组员'), member('STUDENT', '新组组员'),
    member('STUDENT', '未分组样例'),
  ]);
  const admin = await db.user.create({ data: { name: '全站管理员', email: `${key}@test.invalid`, isAdmin: true } });
  const oldGroup = await db.group.create({ data: { offeringId, name: '原来的组' } });
  const newGroup = await db.group.create({ data: { offeringId, name: '后来加入的组' } });
  await moveStudentToGroup(teacher.userId, offeringId, oldGroup.id, student.id);
  await moveStudentToGroup(teacher.userId, offeringId, oldGroup.id, oldPartner.id);
  await moveStudentToGroup(teacher.userId, offeringId, newGroup.id, newPartner.id);
  const lesson = await createCourseSubpage(teacher.userId, offeringId, '小组汇报');
  const assignment = await createAssignment(teacher.userId, offeringId, {
    title: '阶段成果', description: '提交当时的报告', mode: 'GROUP', status: 'PUBLISHED', dueAt: null,
  });
  const submit = async (userId: string) => submitAssignment(userId, offeringId, assignment.id, await confirmedSubmissionInput(userId, offeringId, assignment.id));
  const oldVersion = await submit(oldPartner.userId);
  const newVersion = await submit(newPartner.userId);
  await addFeedback(ta.userId, offeringId, oldVersion.id, '原版本的评语');
  await addFeedback(ta.userId, offeringId, newVersion.id, '入组前新组的评语');
  const personalRecord = await recordTeachingObservation(ta.userId, offeringId, {
    targetMemberId: student.id, targetGroupId: null, versionId: oldVersion.id,
    pageId: lesson.id, contextGroupId: oldGroup.id, body: '本人在原组的课堂表现', requestId: randomUUID(),
  });
  const groupRecord = await recordTeachingObservation(ta.userId, offeringId, {
    targetMemberId: null, targetGroupId: oldGroup.id, versionId: null,
    pageId: lesson.id, body: '原组共同汇报的情况', requestId: randomUUID(),
  });
  const guide = (groupId: string, versionId: string, body: string) => sendTeachingFeedback(ta.userId, offeringId, {
    targetMemberId: null, targetGroupId: groupId, versionId, body, requestId: randomUUID(),
  });
  const received = await guide(oldGroup.id, oldVersion.id, '当时已收到的小组指导');
  await guide(newGroup.id, newVersion.id, '加入新组前已有的共享指导');
  await moveStudentToGroup(teacher.userId, offeringId, newGroup.id, student.id);
  const afterMove = await submit(oldPartner.userId);
  await guide(oldGroup.id, afterMove.id, '离开原组后发给原组的指导');

  const personal = await getTeachingHistory(ta.userId, offeringId, { memberId: student.id });
  assert.equal(personal.member?.groupMemberships.find(row => !row.leftAt)?.group.id, newGroup.id);
  assert.ok(personal.member?.groupMemberships.find(row => row.group.id === oldGroup.id)?.leftAt);
  assert.deepEqual(personal.results.map(row => row.id), [oldVersion.id]);
  assert.equal(personal.results[0].submittedBy.user.name, '旧组组员');
  assert.deepEqual(personal.results[0].reviews.map(row => row.body), ['原版本的评语']);
  assert.deepEqual(personal.guidance.map(row => row.id), [received.id]);
  assert.deepEqual(personal.observations.map(row => [row.id, row.page?.id, row.contextGroup?.id]), [[personalRecord.id, lesson.id, oldGroup.id]]);
  const personalItems = teachingHistoryItems(personal);
  assert.equal(personalItems.length, 1);
  const [work] = personalItems;
  assert.ok(work?.kind === 'result');
  assert.deepEqual(work.notes.map(row => row.id), [personalRecord.id]);
  assert.deepEqual(work.sent.map(row => row.id), [received.id]);
  const personalOverview = teachingHistoryOverview(personal);
  assert.deepEqual(personalOverview.lessons.flatMap(row => row.notes.map(note => note.id)), [personalRecord.id]);
  assert.deepEqual(personalOverview.submissions.map(row => [row.result.id, row.earlier.length]), [[oldVersion.id, 0]]);
  assert.deepEqual(personalOverview.remarks, []);

  const group = await getTeachingHistory(ta.userId, offeringId, { groupId: oldGroup.id });
  assert.deepEqual(group.results.map(row => row.id), [afterMove.id, oldVersion.id]);
  assert.deepEqual(new Set(group.observations.map(row => row.id)), new Set([groupRecord.id, personalRecord.id]));
  assert.deepEqual(teachingHistoryItems(group).find(row => row.kind === 'lesson')?.notes.map(row => row.id), [groupRecord.id]);
  const groupOverview = teachingHistoryOverview(group);
  assert.deepEqual(new Set(groupOverview.lessons[0]?.notes.map(note => note.id)), new Set([groupRecord.id, personalRecord.id]));
  assert.equal(groupOverview.submissions.length, 1);
  assert.equal(groupOverview.submissions[0].result.id, afterMove.id);
  assert.deepEqual(groupOverview.submissions[0].earlier.map(row => row.id), [oldVersion.id]);
  assert.deepEqual(groupOverview.submissions[0].earlier[0].reviews.map(review => review.body), ['原版本的评语']);
  assert.equal((await getTeachingHistory(ta.userId, offeringId, { groupId: newGroup.id })).observations.length, 0);
  await assert.rejects(listTeachingMembers(student.userId, offeringId), DomainError);
  await assert.rejects(getTeachingHistory(admin.id, offeringId, { memberId: student.id }), DomainError);
  await assert.rejects(getTeachingHistory(ta.userId, offeringId, { groupId: randomUUID() }), DomainError);

  const memberOrigin = { fromMember: student.id, fromGroup: oldGroup.id, fromPage: lesson.id, fromLessonRecords: '1', fromMemberSearch: '调组' };
  const resultSource = await getTeachingResultSource(ta.userId, offeringId, assignment.id, memberOrigin, oldVersion.id);
  assert.ok(resultSource);
  const fromResult = new URL(resultSource.href, 'https://local.invalid');
  assert.equal(fromResult.pathname, `/courses/${offeringId}/members/${student.id}`);
  assert.deepEqual(Object.fromEntries(fromResult.searchParams), { fromGroup: oldGroup.id, fromPage: lesson.id, fromLessonRecords: '1', q: '调组' });
  assert.equal(await getTeachingResultSource(ta.userId, offeringId, assignment.id, memberOrigin, afterMove.id), null);
  assert.equal(resultSource.sourceVersionId, oldVersion.id);
  const switched = await getTeachingResultSource(ta.userId, offeringId, assignment.id, memberOrigin, afterMove.id, oldVersion.id);
  assert.equal(switched?.href, resultSource.href);
  assert.equal(switched?.sourceVersionId, oldVersion.id);
  assert.equal(await getTeachingResultSource(ta.userId, offeringId, assignment.id, memberOrigin, newVersion.id, oldVersion.id), null);
  assert.equal(await getTeachingResultSource(ta.userId, offeringId, assignment.id, memberOrigin, afterMove.id, newVersion.id), null);
  assert.equal(await getTeachingResultSource(student.userId, offeringId, assignment.id, memberOrigin, afterMove.id, oldVersion.id), null);
  const studentDetail = await getAssignmentDetail(student.userId, offeringId, assignment.id);
  assert.ok(studentDetail.versions.some(version => version.id === oldVersion.id));
  assert.ok(studentDetail.versions.every(version => version.id !== afterMove.id));
  assert.equal((await getTeachingLessonReturn(ta.userId, offeringId, memberOrigin))?.href, resultSource.href);
  const lessonOrigin = { fromPage: lesson.id, fromLessonRecords: '1' };
  assert.equal((await getTeachingResultSource(ta.userId, offeringId, assignment.id, lessonOrigin))?.href, `/courses/${offeringId}/pages/${lesson.id}?view=records`);
  assert.equal(await getTeachingResultSource(student.userId, offeringId, assignment.id, lessonOrigin), null);

  const groupOrigin = {
    ...lessonOrigin, fromGroup: oldGroup.id, fromGroupMember: student.id, fromGroupMemberPriorGroup: newGroup.id, fromMemberSearch: '调组',
  };
  const viaGroup = await getTeachingResultSource(ta.userId, offeringId, assignment.id, groupOrigin, afterMove.id);
  assert.ok(viaGroup);
  const fromGroup = new URL(viaGroup.href, 'https://local.invalid');
  assert.equal(fromGroup.pathname, `/courses/${offeringId}/groups/${oldGroup.id}`);
  assert.deepEqual(Object.fromEntries(fromGroup.searchParams), {
    ...lessonOrigin, fromMember: student.id, fromGroup: newGroup.id, fromMemberSearch: '调组',
  });
  assert.equal((await getTeachingLessonReturn(ta.userId, offeringId, groupOrigin))?.href, viaGroup.href);
  const forgedParent = await getTeachingLessonReturn(ta.userId, offeringId, { ...groupOrigin, fromGroupMember: newPartner.id });
  assert.ok(forgedParent);
  assert.deepEqual(Object.fromEntries(new URL(forgedParent.href, 'https://local.invalid').searchParams), lessonOrigin);

  const currentGroupVersion = await submit(newPartner.userId);
  const unlinkedLeave = await recordTeachingObservation(ta.userId, offeringId, {
    targetMemberId: student.id, body: '过去收到过请假消息，课次未知', kind: 'LEAVE_REPORTED', requestId: randomUUID(),
  });
  const remark = await recordTeachingObservation(ta.userId, offeringId, {
    targetMemberId: student.id, body: '本期个人备注', requestId: randomUUID(),
  });
  const versionNote = await recordTeachingObservation(ta.userId, offeringId, {
    targetMemberId: student.id, contextGroupId: oldGroup.id, versionId: oldVersion.id,
    body: '这条教学备注仅对应原作品版本', requestId: randomUUID(),
  });
  const unlinkedAbsent = await db.teachingObservation.create({ data: {
    offeringId, authorUserId: ta.userId, targetMemberId: student.id, kind: 'ABSENT',
    body: '兼容未关联课次的早期未到记录', requestId: randomUUID(),
  } });
  const afterNewGroupWork = teachingHistoryOverview(await getTeachingHistory(ta.userId, offeringId, { memberId: student.id }));
  assert.deepEqual(new Set(afterNewGroupWork.submissions.map(row => row.result.id)), new Set([oldVersion.id, currentGroupVersion.id]));
  assert.ok(afterNewGroupWork.submissions.every(row => row.earlier.length === 0));
  assert.deepEqual(afterNewGroupWork.remarks.map(row => row.id), [remark.id]);
  assert.deepEqual(new Set(afterNewGroupWork.unlinkedClassroomNotes.map(row => row.id)), new Set([unlinkedLeave.id, unlinkedAbsent.id]));
  assert.deepEqual(afterNewGroupWork.lessons.flatMap(row => row.notes.map(note => note.id)), [personalRecord.id]);
  const oldGroupAfterNote = teachingHistoryOverview(await getTeachingHistory(ta.userId, offeringId, { groupId: oldGroup.id }));
  assert.equal(oldGroupAfterNote.submissions[0].result.id, afterMove.id);
  assert.deepEqual(oldGroupAfterNote.submissions[0].versionNotes.map(item => [item.version.id, item.notes.map(note => note.id)]),
    [[oldVersion.id, [versionNote.id]]]);
  assert.deepEqual(oldGroupAfterNote.remarks, []);

  await db.courseOffering.update({ where: { id: offeringId }, data: { status: 'ARCHIVED' } });
  assert.deepEqual((await listTeachingMembers(ta.userId, offeringId, ' 未分组样例 ')).map(row => row.id), [ungrouped.id]);
  const empty = await getTeachingHistory(ta.userId, offeringId, { memberId: ungrouped.id });
  assert.equal(empty.member?.id, ungrouped.id);
  assert.deepEqual([empty.results.length, empty.observations.length, empty.guidance.length], [0, 0, 0]);
  const archived = await getTeachingHistory(ta.userId, offeringId, { memberId: student.id });
  assert.equal(archived.observations[0].canAmend, false);
  assert.ok(archived.results.some(row => row.id === oldVersion.id));
  assert.equal((await getTeachingResultSource(ta.userId, offeringId, assignment.id, memberOrigin, afterMove.id, oldVersion.id))?.href, resultSource.href);
});
