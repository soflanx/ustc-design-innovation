import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { db } from '../src/lib/db';
import { createCourseSubpage } from '../src/lib/course-subpages';
import { DomainError, moveStudentToGroup } from '../src/lib/management';
import { createAssignment, submitAssignment } from '../src/lib/teaching';
import { toTeachingDateInput } from '../src/lib/teaching-format';
import { getTeachingHistory, teachingHistoryItems } from '../src/lib/teaching-history';
import {
  correctTeachingObservation, getStudentTeachingFeedback, getTeachingObservations, getTeachingRecordWorkspace,
  getTeachingSubject, recordLessonStudentEvents, recordTeachingObservation, sendTeachingFeedback, withdrawTeachingObservation,
} from '../src/lib/teaching-observations';
import { confirmedSubmissionInput } from './submission-fixture';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(() => db.$disconnect());

async function fixture() {
  const key = randomUUID();
  const offering = await db.courseOffering.create({ data: {
    course: { create: { slug: key, title: '观察测试' } },
    term: { create: { slug: key, name: '测试学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } },
    status: 'ACTIVE', title: '本期观察测试',
  } });
  const offeringId = offering.id;
  const [teacher, ta, first, second, outsider] = await Promise.all((['TEACHER', 'TA', 'STUDENT', 'STUDENT', 'STUDENT'] as const).map((role, index) =>
    db.courseMember.create({ data: { offering: { connect: { id: offeringId } }, role, user: { create: { email: `${key}-${index}@test.invalid`, name: `测试成员${index}` } } } }),
  ));
  const group = await db.group.create({ data: { offeringId, name: '第一组' } });
  const otherGroup = await db.group.create({ data: { offeringId, name: '第二组' } });
  await moveStudentToGroup(teacher.userId, offeringId, group.id, first.id);
  await moveStudentToGroup(teacher.userId, offeringId, group.id, second.id);
  await moveStudentToGroup(teacher.userId, offeringId, otherGroup.id, outsider.id);
  return { offeringId, teacher, ta, first, second, outsider, group, otherGroup };
}

const input = (targetMemberId: string | null, targetGroupId: string | null, body: string, versionId: string | null = null) =>
  ({ targetMemberId, targetGroupId, body, versionId, requestId: randomUUID() });

test('内部观察可按学生和原成果回看，组外与无参与者无法关联，学生不读取内部内容', async () => {
  const { offeringId, teacher, ta, first, second, outsider } = await fixture();
  const assignment = await createAssignment(teacher.userId, offeringId, {
    title: '观察作业', description: '写观察记录', status: 'PUBLISHED', mode: 'GROUP', dueAt: null,
  });
  const version = await submitAssignment(first.userId, offeringId, assignment.id, await confirmedSubmissionInput(first.userId, offeringId, assignment.id));
  const observation = { ...input(second.id, null, '现场内部观察', version.id), observedAt: '2020-11-02T16:00:00.000Z' };
  const [left, right] = await Promise.all([
    recordTeachingObservation(ta.userId, offeringId, observation),
    recordTeachingObservation(ta.userId, offeringId, observation),
  ]);
  assert.deepEqual(left, right);
  const notes = await getTeachingObservations(teacher.userId, offeringId, { memberId: second.id });
  assert.deepEqual(notes.observations.map(row => [row.body, row.version?.id, row.observedAt?.toISOString()]), [['现场内部观察', version.id, observation.observedAt]]);
  const subject = await getTeachingSubject(ta.userId, offeringId, { memberId: second.id });
  assert.equal(subject.results[0]?.id, version.id);
  assert.deepEqual(await getStudentTeachingFeedback(second.userId, offeringId), []);
  await assert.rejects(getTeachingObservations(second.userId, offeringId, { memberId: second.id }), DomainError);
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, input(outsider.id, null, '无参与记录', version.id)), DomainError);
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, { ...observation, body: '冒用旧标识' }), DomainError);
});

test('外发区分个人和小组，调组只改变共享阅读，原收件人保留已收到的反馈', async () => {
  const { offeringId, teacher, ta, first, second, outsider, group, otherGroup } = await fixture();
  const assignment = await createAssignment(teacher.userId, offeringId, {
    title: '组成果', description: '写记录', status: 'PUBLISHED', mode: 'GROUP', dueAt: null,
  });
  const version = await submitAssignment(first.userId, offeringId, assignment.id, await confirmedSubmissionInput(first.userId, offeringId, assignment.id));
  const groupNote = input(null, group.id, '调组前的小组反馈', version.id);
  const sent = await sendTeachingFeedback(ta.userId, offeringId, groupNote);
  assert.deepEqual(await sendTeachingFeedback(ta.userId, offeringId, groupNote), sent);
  await sendTeachingFeedback(ta.userId, offeringId, input(first.id, null, '仅第一位学生可读'));
  await recordTeachingObservation(ta.userId, offeringId, input(null, group.id, '仅教学团队可读'));
  const inbox = async (userId: string) => {
    const entries = await getStudentTeachingFeedback(userId, offeringId);
    assert.ok(entries.every(row => !('targetMemberId' in row) && !('recipients' in row)));
    return new Map(entries.map(row => [row.body, row.recipientBasis]));
  };
  const originalInbox = new Map([['调组前的小组反馈', 'RECEIVED_GROUP'], ['仅第一位学生可读', 'PERSONAL']]);
  assert.deepEqual(await inbox(first.userId), originalInbox);
  assert.deepEqual(await inbox(second.userId), new Map([['调组前的小组反馈', 'RECEIVED_GROUP']]));
  assert.deepEqual(await inbox(outsider.userId), new Map());

  await moveStudentToGroup(teacher.userId, offeringId, otherGroup.id, first.id);
  await moveStudentToGroup(teacher.userId, offeringId, group.id, outsider.id);
  await sendTeachingFeedback(ta.userId, offeringId, input(null, group.id, '调组后的小组反馈'));
  assert.deepEqual(await inbox(first.userId), originalInbox);
  assert.deepEqual(await inbox(outsider.userId), new Map([['调组前的小组反馈', 'CURRENT_GROUP_SHARED'], ['调组后的小组反馈', 'RECEIVED_GROUP']]));
  assert.deepEqual((await getStudentTeachingFeedback(outsider.userId, offeringId)).find(row => row.id === sent.id)?.result, {
    id: version.id, assignmentId: assignment.id, title: assignment.title,
  });
  assert.equal(await db.submissionParticipant.count({ where: { versionId: version.id, courseMemberId: outsider.id } }), 0);
  assert.equal(await db.teachingFeedbackRecipient.count({ where: { feedbackId: sent.id } }), 2);
  await db.courseOffering.update({ where: { id: offeringId }, data: { status: 'ARCHIVED' } });
  assert.equal((await getTeachingObservations(ta.userId, offeringId, { groupId: group.id })).observations.length, 1);
  await assert.rejects(sendTeachingFeedback(ta.userId, offeringId, input(null, group.id, '归档后不发送')), DomainError);
});

test('课次、本人和当时小组读取同一内部记录，调组和跨期筛选不会改写归属', async () => {
  const { offeringId, teacher, ta, first, group, otherGroup } = await fixture();
  const lessonTitle = '第三课 · 原型评议';
  const page = await createCourseSubpage(teacher.userId, offeringId, lessonTitle);
  const ungrouped = await db.courseMember.create({ data: {
    offering: { connect: { id: offeringId } }, role: 'STUDENT',
    user: { create: { name: '尚未分组', email: randomUUID() + '@test.invalid' } },
  } });
  const membership = await db.groupMember.findFirstOrThrow({ where: { offeringId, groupId: group.id, courseMemberId: first.id } });
  const entry = {
    ...input(first.id, null, '提出如何验证路口导视的问题'), kind: 'PARTICIPATION' as const,
    pageId: page.id, contextGroupId: group.id, observedAt: membership.joinedAt.toISOString(),
  };
  const saved = await recordTeachingObservation(ta.userId, offeringId, entry);
  assert.deepEqual(await recordTeachingObservation(ta.userId, offeringId, entry), saved);
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, { ...entry, kind: 'OBSERVATION' }), /标识已被使用/);
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, { ...entry, pageId: null }), /标识已被使用/);
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, { ...entry, requestId: randomUUID(), contextGroupId: otherGroup.id }), /小组归属/);
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, { ...entry, requestId: randomUUID(), observedAt: '2000-01-01T00:00:00.000Z' }), /小组归属/);
  const another = await fixture();
  const otherPage = await createCourseSubpage(another.teacher.userId, another.offeringId, '另一期课');
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, { ...entry, requestId: randomUUID(), pageId: otherPage.id }), DomainError);
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, { ...entry, requestId: randomUUID(), contextGroupId: another.group.id }), DomainError);

  await moveStudentToGroup(teacher.userId, offeringId, otherGroup.id, first.id);
  for (const scope of [{ memberId: first.id }, { pageId: page.id }, { groupId: group.id }]) {
    const { observations: [record] } = await getTeachingObservations(teacher.userId, offeringId, scope);
    assert.equal(record.id, saved.id);
    assert.equal(record.kind, 'PARTICIPATION');
    assert.equal(record.page?.title, lessonTitle);
    assert.equal(record.contextGroup?.id, group.id);
    assert.equal(record.canAmend, false);
  }
  assert.deepEqual((await getTeachingObservations(teacher.userId, offeringId, { groupId: otherGroup.id })).observations, []);
  const workspace = await getTeachingRecordWorkspace(ta.userId, offeringId, { pageId: page.id, memberId: first.id, groupId: group.id });
  assert.equal(workspace.filterAvailable, true);
  assert.equal(workspace.observations[0]?.id, saved.id);
  assert.equal(workspace.observations[0]?.canAmend, true);
  assert.deepEqual(workspace.students.find(student => student.id === ungrouped.id)?.groupMemberships, []);
  const invalid = await getTeachingRecordWorkspace(ta.userId, offeringId, { pageId: otherPage.id });
  assert.equal(invalid.filterAvailable, false);
  assert.deepEqual(invalid.observations, []);
  assert.equal(invalid.pages.some(candidate => candidate.id === otherPage.id), false);
  await assert.rejects(getTeachingRecordWorkspace(first.userId, offeringId), DomainError);
  await assert.rejects(getTeachingObservations(first.userId, offeringId, { pageId: page.id }), DomainError);
  assert.deepEqual(await getStudentTeachingFeedback(first.userId, offeringId), []);
});

test('草稿课可以只写整堂课的正文，也可按需关联学生或小组', async () => {
  const { offeringId, teacher, ta, first, group } = await fixture();
  const page = await createCourseSubpage(ta.userId, offeringId, '整堂课可直接记');
  const other = await createCourseSubpage(ta.userId, offeringId, '另一课次');
  assert.equal(page.publishedAt, null);
  const admin = await db.user.create({ data: { email: randomUUID() + '@test.invalid', name: '纯管理员', isAdmin: true } });
  const whole = { pageId: page.id, body: '下次演示补一组空白对照', requestId: randomUUID() };
  const saved = await recordTeachingObservation(ta.userId, offeringId, whole);
  assert.deepEqual(await recordTeachingObservation(ta.userId, offeringId, whole), saved);
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, { ...whole, pageId: other.id }), /标识已被使用/);

  const student = await recordTeachingObservation(ta.userId, offeringId, {
    pageId: page.id, targetMemberId: first.id, body: '学生解释了差异', requestId: randomUUID(),
  });
  const team = await recordTeachingObservation(ta.userId, offeringId, {
    pageId: page.id, targetGroupId: group.id, body: '小组需要补看原件', requestId: randomUUID(),
  });
  const read = await getTeachingObservations(teacher.userId, offeringId, { pageId: page.id });
  assert.deepEqual(new Set(read.observations.map(note => note.id)), new Set([saved.id, student.id, team.id]));
  const lessonNote = read.observations.find(note => note.id === saved.id)!;
  assert.equal(lessonNote.page?.id, page.id);
  assert.equal(lessonNote.body, whole.body);
  assert.equal(lessonNote.targetMember, null);
  assert.equal(lessonNote.targetGroup, null);
  assert.equal(lessonNote.observedAt, null);
  assert.deepEqual((await getTeachingObservations(teacher.userId, offeringId, { memberId: first.id })).observations.map(note => note.id), [student.id]);
  assert.deepEqual((await getTeachingObservations(teacher.userId, offeringId, { groupId: group.id })).observations.map(note => note.id), [team.id]);
  assert.deepEqual((await getTeachingObservations(teacher.userId, offeringId, { pageId: other.id })).observations, []);

  await withdrawTeachingObservation(ta.userId, offeringId, saved.id, { expectedRevision: 0, reason: '重复记事', requestId: randomUUID() });
  assert.ok(!(await getTeachingObservations(teacher.userId, offeringId, { pageId: page.id })).observations.some(note => note.id === saved.id));
  const history = await getTeachingObservations(teacher.userId, offeringId, { pageId: page.id }, { includeWithdrawn: true });
  assert.equal(history.observations.find(note => note.id === saved.id)?.withdrawn, true);
  for (const actor of [first.userId, admin.id]) {
    await assert.rejects(getTeachingObservations(actor, offeringId, { pageId: page.id }), DomainError);
    await assert.rejects(recordTeachingObservation(actor, offeringId, { ...whole, requestId: randomUUID() }), DomainError);
  }
});

test('整堂课记录必须关联本期课次，且不会放宽已有的人组与外发约束', async () => {
  const { offeringId, ta, first, group } = await fixture();
  const page = await createCourseSubpage(ta.userId, offeringId, '本期课');
  const another = await fixture();
  const foreign = await createCourseSubpage(another.ta.userId, another.offeringId, '另一期课');
  const payload = { body: '没有必要挂到个人的内容', requestId: randomUUID() };
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, payload), /记录整堂课/);
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, { ...payload, pageId: foreign.id }), DomainError);
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, { ...payload, pageId: page.id, versionId: '错误成果' }), /记录整堂课/);
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, { ...payload, pageId: page.id, targetMemberId: first.id, targetGroupId: group.id }), /选择一位学生/);
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, { ...payload, pageId: page.id, kind: 'LEAVE_REPORTED' }), /请假记录选择一位学生/);
  await assert.rejects(sendTeachingFeedback(ta.userId, offeringId, { ...payload, versionId: null, targetMemberId: null, targetGroupId: null }), /选择一位学生或一个小组/);

  const raw = { ...payload, offeringId, authorUserId: ta.userId };
  await assert.rejects(db.teachingObservation.create({ data: raw }));
  await assert.rejects(db.teachingObservation.create({ data: { ...raw, pageId: foreign.id } }));
  await assert.rejects(db.teachingObservation.create({ data: { ...raw, pageId: page.id, targetMemberId: first.id, targetGroupId: group.id } }));
  assert.equal(await db.teachingObservation.count({ where: { offeringId } }), 0);
});

test('收到请假、已有确认和教学判断分别记录，未知时间保持为空', async () => {
  const { offeringId, teacher, ta, first, group } = await fixture();
  const received = { ...input(first.id, null, '收到学生的请假消息'), kind: 'LEAVE_REPORTED' as const };
  const confirmed = { ...input(first.id, null, '已收到教师确认'), kind: 'LEAVE_CONFIRMED' as const };
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, confirmed), /确认请假的来源/);
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, { ...received, targetMemberId: null, targetGroupId: group.id }), /选择一位学生/);
  const prior = await db.courseMember.findUniqueOrThrow({ where: { id: first.id } });
  await recordTeachingObservation(ta.userId, offeringId, received);
  const decided = await recordTeachingObservation(ta.userId, offeringId, { ...confirmed, context: '教师课前口头确认' });
  await recordTeachingObservation(teacher.userId, offeringId, {
    ...input(first.id, null, '下一次可以多追问一个具体例子'), kind: 'TEACHING_JUDGMENT', contextGroupId: group.id,
  });
  await assert.rejects(correctTeachingObservation(ta.userId, offeringId, decided.id, {
    expectedRevision: 0, requestId: randomUUID(), body: '补充记录', context: '',
  }), /确认请假的来源/);
  const { observations } = await getTeachingObservations(teacher.userId, offeringId, { memberId: first.id });
  assert.deepEqual(new Set(observations.map(item => item.kind)), new Set(['LEAVE_REPORTED', 'LEAVE_CONFIRMED', 'TEACHING_JUDGMENT']));
  assert.ok(observations.every(item => item.observedAt === null));
  assert.deepEqual(await db.courseMember.findUniqueOrThrow({ where: { id: first.id } }), prior);
});

test('本课多人情况一次保存为逐人原件，整份名单和内容决定同一请求的重试', async () => {
  const { offeringId, teacher, ta, first, second, outsider } = await fixture();
  const page = await createCourseSubpage(ta.userId, offeringId, '讨论课');
  const otherPage = await createCourseSubpage(ta.userId, offeringId, '另一堂课');
  const ungrouped = await db.courseMember.create({ data: { offering: { connect: { id: offeringId } }, role: 'STUDENT',
    user: { create: { email: `${randomUUID()}@test.invalid`, name: '测试未分组学生' } } } });
  const event = { pageId: page.id, kind: 'ABSENT' as const, memberIds: [ungrouped.id, first.id], requestId: randomUUID() };
  const [saved, retried] = await Promise.all([
    recordLessonStudentEvents(ta.userId, offeringId, event),
    recordLessonStudentEvents(ta.userId, offeringId, { ...event, memberIds: [first.id, ungrouped.id], body: ' 未到 ' }),
  ]);
  assert.deepEqual(saved, retried);
  assert.equal(saved.records.length, 2);
  const firstRecord = saved.records.find(item => item.memberId === first.id)!;
  const { observations } = await getTeachingObservations(teacher.userId, offeringId, { pageId: page.id });
  assert.deepEqual(new Set(observations.map(item => item.id)), new Set(saved.records.map(item => item.recordId)));
  assert.ok(observations.every(item => item.kind === 'ABSENT' && item.body === '未到' && item.observedAt === null && !item.contextGroup && !item.targetGroup && !item.version));
  const personal = await getTeachingHistory(teacher.userId, offeringId, { memberId: first.id });
  const lesson = teachingHistoryItems(personal).find(item => item.kind === 'lesson' && item.page.id === page.id);
  assert.deepEqual(lesson?.kind === 'lesson' && lesson.notes.map(note => note.id), [firstRecord.recordId]);
  assert.deepEqual((await getTeachingObservations(ta.userId, offeringId, { memberId: second.id })).observations, []);
  assert.deepEqual(await getStudentTeachingFeedback(first.userId, offeringId), []);

  for (const mismatch of [
    { memberIds: [first.id] }, { memberIds: [first.id, second.id] }, { memberIds: [second.id, outsider.id] },
    { memberIds: [...event.memberIds, second.id] }, { pageId: otherPage.id }, { kind: 'LEAVE_REPORTED' as const }, { body: '不同备注' },
  ]) await assert.rejects(recordLessonStudentEvents(ta.userId, offeringId, { ...event, ...mismatch }), /标识已被使用/);
  await assert.rejects(recordLessonStudentEvents(teacher.userId, offeringId, event), /标识已被使用/);

  await withdrawTeachingObservation(ta.userId, offeringId, firstRecord.recordId, { expectedRevision: 0, reason: '点错学生', requestId: randomUUID() });
  await db.courseMember.update({ where: { id: ungrouped.id }, data: { status: 'INACTIVE' } });
  assert.deepEqual(await recordLessonStudentEvents(ta.userId, offeringId, event), saved);
  const after = await getTeachingObservations(ta.userId, offeringId, { pageId: page.id });
  assert.deepEqual(after.observations.map(note => note.targetMember?.id), [ungrouped.id]);
  assert.equal(await db.teachingObservation.count({ where: { offeringId, pageId: page.id } }), 2);
});

test('本课情况批次拒绝越期、无效名单及无权或归档写入，失败不会留下部分记录', async () => {
  const { offeringId, teacher, ta, first, second } = await fixture();
  const foreign = await fixture();
  const page = await createCourseSubpage(teacher.userId, offeringId, '课堂情况');
  const foreignPage = await createCourseSubpage(foreign.teacher.userId, foreign.offeringId, '其他期的课');
  const admin = await db.user.create({ data: { email: `${randomUUID()}@test.invalid`, name: '纯管理员', isAdmin: true } });
  const event = { pageId: page.id, kind: 'LEAVE_REPORTED' as const, memberIds: [first.id, second.id], requestId: randomUUID() };
  await db.courseMember.update({ where: { id: second.id }, data: { status: 'INACTIVE' } });
  for (const userId of [first.userId, admin.id, foreign.ta.userId]) {
    await assert.rejects(recordLessonStudentEvents(userId, offeringId, event), /没有访问本期教学记录/);
  }
  await assert.rejects(recordLessonStudentEvents(ta.userId, offeringId, { ...event, pageId: foreignPage.id }), /关联情境不可用/);
  for (const invalid of [second.id, teacher.id, foreign.first.id, randomUUID()]) {
    await assert.rejects(recordLessonStudentEvents(ta.userId, offeringId, { ...event, memberIds: [first.id, invalid] }), /本期有效名单/);
  }
  await assert.rejects(recordLessonStudentEvents(ta.userId, offeringId, { ...event, memberIds: [] }), /至少选择一位/);
  await assert.rejects(recordLessonStudentEvents(ta.userId, offeringId, { ...event, memberIds: [first.id, first.id] }), /名单有重复/);
  await assert.rejects(recordLessonStudentEvents(ta.userId, offeringId, { ...event, kind: 'PARTICIPATION', body: '  ' }), /填写课堂发言/);
  await assert.rejects(recordLessonStudentEvents(ta.userId, offeringId, { ...event, kind: 'LEAVE_CONFIRMED' as never }), /请选择请假、未到或课堂发言/);
  await assert.rejects(recordLessonStudentEvents(ta.userId, offeringId, { ...event, body: 'a'.repeat(12001) }), /12000 字以内/);
  await assert.rejects(recordLessonStudentEvents(ta.userId, offeringId, { ...event, body: '无效\u0000字符' }), /无效字符/);
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, { ...input(first.id, null, '旧入口'), pageId: page.id, kind: 'ABSENT' }), /本课的学生情况/);
  assert.equal(await db.teachingObservation.count({ where: { offeringId } }), 0);

  const valid = { ...event, memberIds: [first.id] };
  await recordLessonStudentEvents(ta.userId, offeringId, valid);
  await assert.rejects(recordLessonStudentEvents(foreign.ta.userId, foreign.offeringId, {
    ...valid, pageId: foreignPage.id, memberIds: [foreign.first.id],
  }), /标识已被使用/);
  await recordLessonStudentEvents(ta.userId, offeringId, { ...valid, kind: 'PARTICIPATION', body: '指出比较口径的差异', requestId: randomUUID() });
  const observations = (await getTeachingObservations(teacher.userId, offeringId, { pageId: page.id })).observations;
  assert.deepEqual(new Map(observations.map(note => [note.kind, note.body])), new Map([
    ['LEAVE_REPORTED', '收到请假'], ['PARTICIPATION', '指出比较口径的差异'],
  ]));
  await db.courseMember.update({ where: { id: ta.id }, data: { status: 'INACTIVE' } });
  await assert.rejects(recordLessonStudentEvents(ta.userId, offeringId, valid), /没有访问本期教学记录/);
  await db.courseOffering.update({ where: { id: offeringId }, data: { status: 'ARCHIVED' } });
  await assert.rejects(recordLessonStudentEvents(teacher.userId, offeringId, { ...valid, requestId: randomUUID() }), /已归档课程保持只读/);
  assert.equal((await getTeachingHistory(teacher.userId, offeringId, { memberId: first.id })).observations.length, 2);
});

test('并发更正、重试与撤回保留原记录和有效版本，按期限制作者写入', async () => {
  const { offeringId, teacher, ta, first } = await fixture();
  const page = await createCourseSubpage(teacher.userId, offeringId, '观察课');
  const observedAt = '2020-11-02T16:00:00.000Z';
  const { id: observationId } = await recordTeachingObservation(ta.userId, offeringId, {
    ...input(first.id, null, '原始观察'), pageId: page.id, context: '原情境', observedAt,
  });
  const edit = (body: string) => ({ expectedRevision: 0, requestId: randomUUID(), body });
  const edits = [edit('更正甲'), edit('更正乙')];
  await assert.rejects(correctTeachingObservation(teacher.userId, offeringId, observationId, edit('其他作者')), /原记录作者/);
  const attempts = await Promise.allSettled(edits.map(change => correctTeachingObservation(ta.userId, offeringId, observationId, change)));
  const winner = attempts.findIndex(result => result.status === 'fulfilled');
  assert.notEqual(winner, -1);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const loser = attempts[1 - winner];
  assert.ok(loser.status === 'rejected' && loser.reason instanceof DomainError);
  const original = await db.teachingObservation.findUniqueOrThrow({ where: { id: observationId } });
  assert.equal(original.body, '原始观察');
  const firstChange = edits[winner];
  assert.deepEqual(await correctTeachingObservation(ta.userId, offeringId, observationId, firstChange), { id: observationId, revision: 1 });
  await assert.rejects(correctTeachingObservation(ta.userId, offeringId, observationId, { ...firstChange, body: '更换请求' }), /标识已被使用/);
  const [corrected] = (await getTeachingObservations(ta.userId, offeringId, { pageId: page.id })).observations;
  assert.equal(corrected.body, firstChange.body);
  assert.equal(corrected.context, '原情境');
  assert.equal(corrected.observedAt?.toISOString(), observedAt);
  assert.deepEqual(corrected.history.map(item => item.body), ['原始观察', firstChange.body]);
  await correctTeachingObservation(ta.userId, offeringId, observationId, {
    ...edit('最终更正'), expectedRevision: 1, observedAt: null,
  });
  assert.deepEqual(await correctTeachingObservation(ta.userId, offeringId, observationId, firstChange), { id: observationId, revision: 1 });
  const removal = { expectedRevision: 2, requestId: randomUUID(), reason: '误记对象，撤回后另记' };
  const removed = await withdrawTeachingObservation(ta.userId, offeringId, observationId, removal);
  assert.deepEqual(await withdrawTeachingObservation(ta.userId, offeringId, observationId, removal), removed);
  assert.deepEqual((await getTeachingRecordWorkspace(ta.userId, offeringId)).observations, []);
  const [withdrawn] = (await getTeachingRecordWorkspace(teacher.userId, offeringId, { includeWithdrawn: true })).observations;
  assert.equal(withdrawn.id, observationId);
  assert.equal(withdrawn.body, '最终更正');
  assert.equal(withdrawn.observedAt, null);
  assert.equal(withdrawn.canAmend, false);
  assert.equal(withdrawn.history.at(-1)?.reason, removal.reason);
  assert.deepEqual(withdrawn.history.map(item => item.action), ['RECORDED', 'CORRECTED', 'CORRECTED', 'WITHDRAWN']);
  await assert.rejects(correctTeachingObservation(ta.userId, offeringId, observationId, { ...edit('已撤回'), expectedRevision: 3 }), /已撤回/);
  await assert.rejects(db.teachingObservationRevision.updateMany({ where: { observationId }, data: { body: '尝试覆盖' } }));
  await db.courseOffering.update({ where: { id: offeringId }, data: { status: 'ARCHIVED' } });
  assert.equal((await getTeachingRecordWorkspace(ta.userId, offeringId, { includeWithdrawn: true })).archived, true);
  await assert.rejects(withdrawTeachingObservation(ta.userId, offeringId, observationId, removal), /归档/);
});

test('实际发生日期按北京时间拒绝将来日期并保留未更改的历史原值', async () => {
  const { offeringId, ta, first, group } = await fixture();
  const now = new Date();
  const today = toTeachingDateInput(now).slice(0, 10);
  const todayMidnight = new Date(today + 'T00:00:00+08:00').toISOString();
  const todayEvening = new Date(today + 'T23:59:59+08:00').toISOString();
  const future = new Date(now.getTime() + 2 * 86400000).toISOString();
  const entry = { ...input(first.id, null, '课堂发言'), kind: 'PARTICIPATION' as const, contextGroupId: group.id };
  await assert.rejects(recordTeachingObservation(ta.userId, offeringId, { ...entry, observedAt: future }), /北京时间今天/);
  assert.equal(await db.teachingObservation.count({ where: { requestId: entry.requestId } }), 0);

  const { id: saved } = await recordTeachingObservation(ta.userId, offeringId, { ...entry, observedAt: todayEvening });
  assert.equal((await db.teachingObservation.findUniqueOrThrow({ where: { id: saved } })).observedAt?.toISOString(), todayEvening);
  const edit = { expectedRevision: 0, requestId: randomUUID(), body: '更正发言内容' };
  await assert.rejects(correctTeachingObservation(ta.userId, offeringId, saved, { ...edit, observedAt: future }), /北京时间今天/);
  assert.equal(await db.teachingObservationRevision.count({ where: { observationId: saved } }), 0);
  await correctTeachingObservation(ta.userId, offeringId, saved, { ...edit, observedAt: todayMidnight });
  const current = (await getTeachingObservations(ta.userId, offeringId, { memberId: first.id })).observations.find(item => item.id === saved);
  assert.equal(current?.observedAt?.toISOString(), todayMidnight);

  const legacy = await db.teachingObservation.create({ data: {
    ...input(first.id, null, '旧记录日期'), offeringId, authorUserId: ta.userId, observedAt: new Date(future),
  } });
  await correctTeachingObservation(ta.userId, offeringId, legacy.id, { ...edit, requestId: randomUUID() });
  await correctTeachingObservation(ta.userId, offeringId, legacy.id, {
    ...edit, expectedRevision: 1, requestId: randomUUID(), observedAt: future,
  });
  const unchanged = (await getTeachingObservations(ta.userId, offeringId, { memberId: first.id })).observations.find(item => item.id === legacy.id);
  assert.equal(unchanged?.observedAt?.toISOString(), future);
  assert.equal(unchanged?.history[0].observedAt?.toISOString(), future);
});

test('停用作者后本期有效教师可说明原因撤回，助教不能替人撤回且教师不能替人更正', async () => {
  const { offeringId, teacher, ta, first } = await fixture();
  const anotherTa = await db.courseMember.create({ data: {
    offering: { connect: { id: offeringId } }, role: 'TA',
    user: { create: { name: '另一位助教', email: randomUUID() + '@test.invalid' } },
  } });
  const admin = await db.user.create({ data: { name: '纯管理员', email: randomUUID() + '@test.invalid', isAdmin: true } });
  const { id: observationId } = await recordTeachingObservation(ta.userId, offeringId, input(first.id, null, '记错学生的内容'));
  const request = { expectedRevision: 0, requestId: randomUUID(), reason: '作者已停用，核对后撤回误记' };
  await assert.rejects(withdrawTeachingObservation(anotherTa.userId, offeringId, observationId, request), /原记录作者或本期教师/);
  await assert.rejects(withdrawTeachingObservation(admin.id, offeringId, observationId, request), /没有访问本期教学记录的权限/);
  await assert.rejects(correctTeachingObservation(teacher.userId, offeringId, observationId, {
    expectedRevision: 0, requestId: randomUUID(), body: '教师代改',
  }), /只有原记录作者可以更正/);
  const [otherTaView] = (await getTeachingRecordWorkspace(anotherTa.userId, offeringId)).observations;
  assert.equal(otherTaView.canAmend, false);
  assert.equal(otherTaView.canWithdraw, false);
  await db.courseMember.update({ where: { id: ta.id }, data: { status: 'INACTIVE' } });
  await assert.rejects(withdrawTeachingObservation(ta.userId, offeringId, observationId, request), /没有访问本期教学记录的权限/);
  const [teacherView] = (await getTeachingRecordWorkspace(teacher.userId, offeringId)).observations;
  assert.equal(teacherView.canAmend, false);
  assert.equal(teacherView.canWithdraw, true);

  const removal = await withdrawTeachingObservation(teacher.userId, offeringId, observationId, request);
  assert.deepEqual(await withdrawTeachingObservation(teacher.userId, offeringId, observationId, request), removal);
  const original = await db.teachingObservation.findUniqueOrThrow({ where: { id: observationId } });
  const revision = await db.teachingObservationRevision.findUniqueOrThrow({
    where: { observationId_revision: { observationId, revision: 1 } },
  });
  assert.equal(original.authorUserId, ta.userId);
  assert.equal(revision.authorUserId, teacher.userId);
  assert.equal(revision.reason, request.reason);
  assert.deepEqual((await getTeachingRecordWorkspace(teacher.userId, offeringId)).observations, []);
  const [withdrawn] = (await getTeachingRecordWorkspace(teacher.userId, offeringId, { includeWithdrawn: true })).observations;
  assert.equal(withdrawn.canAmend, false);
  assert.equal(withdrawn.canWithdraw, false);
});

test('课堂记录追加迁移保留旧观察、外发和原始未知信息', async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const schema = 'record_migration_' + randomUUID().replaceAll('-', '');
  const migration = '20261110000000_classroom_teaching_records';
  const migrations = path.resolve('prisma/migrations');
  await client.connect();
  try {
    await client.query('CREATE SCHEMA "' + schema + '"');
    await client.query('SET search_path TO "' + schema + '"');
    for (const entry of (await readdir(migrations)).filter(name => /^\d/.test(name) && name < migration).sort()) {
      await client.query(await readFile(path.join(migrations, entry, 'migration.sql'), 'utf8'));
    }
    await client.query(`
      INSERT INTO "User" (id,email,name) VALUES ('t','teacher@legacy.invalid','教师'), ('s','student@legacy.invalid','学生');
      INSERT INTO "Course" (id,slug,title) VALUES ('c','legacy','旧课程');
      INSERT INTO "Term" (id,slug,name,"startDate","endDate") VALUES ('term','legacy','旧学期','2030-01-01','2031-01-01');
      INSERT INTO "CourseOffering" (id,"courseId","termId",title,status) VALUES ('o','c','term','旧开课','ACTIVE');
      INSERT INTO "CourseMember" (id,"offeringId","userId",role) VALUES ('mt','o','t','TEACHER'), ('ms','o','s','STUDENT');
      INSERT INTO "TeachingObservation" (id,"offeringId","authorUserId","targetMemberId",body,context,"observedAt","requestId")
        VALUES ('n','o','t','ms','旧记录','旧情境','2030-02-04 16:00:00','observation-request');
      INSERT INTO "TeachingFeedback" (id,"offeringId","authorUserId","targetMemberId",body,"requestId")
        VALUES ('f','o','t','ms','旧反馈','feedback-request');
      INSERT INTO "TeachingFeedbackRecipient" ("offeringId","feedbackId","memberId") VALUES ('o','f','ms');
    `);
    const { rows: [before] } = await client.query('SELECT * FROM "TeachingObservation"');
    const feedbackBefore = (await client.query('SELECT * FROM "TeachingFeedback"')).rows;
    const recipientsBefore = (await client.query('SELECT * FROM "TeachingFeedbackRecipient"')).rows;
    await client.query(await readFile(path.join(migrations, migration, 'migration.sql'), 'utf8'));
    await client.query(await readFile(path.join(migrations, '20261110001000_lesson_subject_observations', 'migration.sql'), 'utf8'));
    await client.query(await readFile(path.join(migrations, '20261110002000_lesson_student_events', 'migration.sql'), 'utf8'));
    const { rows: [{ kind, pageId, contextGroupId, ...original }] } = await client.query('SELECT * FROM "TeachingObservation"');
    assert.deepEqual({ kind, pageId, contextGroupId }, { kind: null, pageId: null, contextGroupId: null });
    assert.deepEqual(original, before);
    assert.deepEqual((await client.query('SELECT * FROM "TeachingFeedback"')).rows, feedbackBefore);
    assert.deepEqual((await client.query('SELECT * FROM "TeachingFeedbackRecipient"')).rows, recipientsBefore);
    assert.deepEqual((await client.query('SELECT * FROM "TeachingObservationRevision"')).rows, []);
    await assert.rejects(client.query('UPDATE "TeachingObservation" SET body = \'覆盖\''), /append-only/);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.query('SET search_path TO public');
    await client.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    await client.end();
  }
});
