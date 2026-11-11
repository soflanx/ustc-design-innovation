import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { db } from '../src/lib/db';
import {
  createStudentGroup, getGroupFormationWindow, joinStudentGroup, listRecruitingGroups, readGroupInvitation,
  setGroupFormation, updateGroupRecruitment,
} from '../src/lib/group-formation';
import { createGroup, getGroupPageHistory, moveStudentToGroup, setOfferingStatus } from '../src/lib/management';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(async () => { await db.$disconnect(); });

async function fixture(status: 'DRAFT' | 'ACTIVE' = 'ACTIVE') {
  const key = randomUUID();
  const course = await db.course.create({ data: { slug: key, title: '隔离组队课程' } });
  const term = await db.term.create({ data: {
    slug: key, name: '隔离组队学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01'),
  } });
  const offering = await db.courseOffering.create({ data: { courseId: course.id, termId: term.id, title: '隔离组队课堂', status } });
  const user = (name: string) => db.user.create({ data: { name, email: `${name}-${key}@test.invalid` } });
  const teacher = await user('teacher');
  const ta = await user('ta');
  const outsider = await user('outsider');
  const students = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(user));
  await db.courseMember.createMany({ data: [
    { offeringId: offering.id, userId: teacher.id, role: 'TEACHER' },
    { offeringId: offering.id, userId: ta.id, role: 'TA' },
    ...students.map(student => ({ offeringId: offering.id, userId: student.id, role: 'STUDENT' as const })),
  ] });
  const legacy = await createGroup(teacher.id, offering.id, '老师建立的组', '不应出现在招募列表的正文');
  return { offering, teacher, ta, outsider, students, legacy };
}

const future = () => new Date(Date.now() + 3600_000);
const open = async (f: Awaited<ReturnType<typeof fixture>>, capacity: number, expectedOpenWindowId: string | null = null) =>
  (await setGroupFormation(f.teacher.id, f.offering.id, { capacity, closesAt: future() }, expectedOpenWindowId))!;
const studentId = (offeringId: string, userId: string) => db.courseMember.findUniqueOrThrow({
  where: { offeringId_userId: { offeringId, userId } }, select: { id: true },
});

test('组队可在筹备期由教师开放，修改容量沿用窗口，关闭、到期及归档分开处理', async () => {
  const f = await fixture('DRAFT');
  const { id: offeringId } = f.offering;
  assert.equal(getGroupFormationWindow(f.offering), null);
  assert.equal(f.legacy.recruitmentMode, null);
  for (const actor of [f.ta, f.students[0], f.outsider]) {
    await assert.rejects(setGroupFormation(actor.id, offeringId, { capacity: 2, closesAt: future() }, null), /教师或管理员/);
  }
  await assert.rejects(setGroupFormation(f.teacher.id, offeringId, { capacity: 1, closesAt: future() }, null), /至少为 2/);
  await assert.rejects(setGroupFormation(f.teacher.id, offeringId, { capacity: 101, closesAt: future() }, null), /最多为 100/);
  await assert.rejects(setGroupFormation(f.teacher.id, offeringId, { capacity: 2, closesAt: new Date(0) }, null), /晚于当前时间/);
  const first = await open(f, 2);
  const adjusted = await open(f, 4, first.id);
  assert.equal(adjusted.id, first.id);
  assert.equal(adjusted.capacity, 4);
  assert.equal(await setGroupFormation(f.teacher.id, offeringId, null, adjusted.id), null);
  const closed = await db.courseOffering.findUniqueOrThrow({ where: { id: offeringId } });
  assert.equal(getGroupFormationWindow(closed), null);
  assert.equal(closed.groupFormationWindowId, first.id);
  assert.equal(closed.groupFormationCapacity, 4);
  assert.ok(closed.groupFormationClosesAt && closed.groupFormationClosesAt <= new Date());

  const next = await open(f, 3);
  assert.notEqual(next.id, first.id);
  await db.courseOffering.update({ where: { id: offeringId }, data: { groupFormationClosesAt: new Date(0) } });
  const reopened = await open(f, 2);
  assert.notEqual(reopened.id, next.id);
  await setOfferingStatus(f.teacher.id, offeringId, 'ARCHIVED');
  const archived = await db.courseOffering.findUniqueOrThrow({ where: { id: offeringId } });
  assert.deepEqual([archived.groupFormationWindowId, archived.groupFormationCapacity, archived.groupFormationClosesAt], [null, null, null]);
  await assert.rejects(open(f, 2), /已归档/);
  assert.equal(getGroupFormationWindow(await setOfferingStatus(f.teacher.id, offeringId, 'ACTIVE')), null);
});

test('关闭并重开后，旧教师表单不能关闭新窗口或覆盖新设置', async () => {
  const f = await fixture();
  const { id: offeringId } = f.offering;
  const first = await open(f, 2);
  await setGroupFormation(f.teacher.id, offeringId, null, first.id);
  await assert.rejects(open(f, 4, first.id), /安排已有变化/);
  const next = await open(f, 3);
  await assert.rejects(setGroupFormation(f.teacher.id, offeringId, null, first.id), /安排已有变化/);
  await assert.rejects(open(f, 4, first.id), /安排已有变化/);
  assert.deepEqual(getGroupFormationWindow(await db.courseOffering.findUniqueOrThrow({ where: { id: offeringId } })), next);
});

test('自助目录与邀请只提供摘要，须本期未组学生确认且组内仍有余位', async () => {
  const f = await fixture();
  const foreign = await fixture();
  const { id: offeringId } = f.offering;
  const { id: windowId } = await open(f, 2);
  const foreignWindow = await open(foreign, 2);
  const [ownerA, ownerB, invitee, classmate, inactive] = f.students;
  const listed = (await createStudentGroup(ownerA.id, offeringId, {
    name: '导视观察组', note: '讨论北门路标', mode: 'COURSE', windowId, requestId: randomUUID(),
  })).groupId!;
  const invited = (await createStudentGroup(ownerB.id, offeringId, {
    name: '访谈组', note: '约同学一起试访谈', mode: 'INVITE', windowId, requestId: randomUUID(),
  })).groupId!;
  const secret = await db.group.update({ where: { id: invited }, data: { description: '仅组内读的工作材料' } });
  const token = secret.recruitmentToken!;
  const listedSummary = { id: listed, name: '导视观察组', note: '讨论北门路标', remaining: 1 };
  const invitedSummary = { name: '访谈组', note: '约同学一起试访谈', remaining: 1 };
  await db.courseMember.update({ where: { offeringId_userId: { offeringId, userId: inactive.id } }, data: { status: 'INACTIVE' } });
  assert.deepEqual(await listRecruitingGroups(invitee.id, offeringId), [listedSummary]);
  assert.deepEqual(await readGroupInvitation(invitee.id, offeringId, token), invitedSummary);
  assert.equal(await readGroupInvitation(invitee.id, offeringId, '无效邀请'), null);
  for (const actor of [f.ta, f.outsider, ownerA, inactive, foreign.students[0]]) {
    assert.deepEqual(await listRecruitingGroups(actor.id, offeringId), []);
    assert.equal(await readGroupInvitation(actor.id, offeringId, token), null);
  }
  const target = (await studentId(offeringId, invitee.id)).id;
  assert.equal(await db.groupMember.count({ where: { courseMemberId: target } }), 0);
  await assert.rejects(getGroupPageHistory(invitee.id, offeringId, invited), /无权查看/);
  await assert.rejects(joinStudentGroup(invitee.id, offeringId, { groupId: invited, windowId, requestId: randomUUID() }), /已失效/);
  await assert.rejects(joinStudentGroup(foreign.students[0].id, foreign.offering.id, {
    inviteToken: token, windowId: foreignWindow.id, requestId: randomUUID(),
  }), /已失效/);

  const request = { inviteToken: token, windowId, requestId: randomUUID() };
  assert.deepEqual(await joinStudentGroup(invitee.id, offeringId, request), { groupId: invited });
  assert.deepEqual(await joinStudentGroup(invitee.id, offeringId, request), { groupId: invited });
  assert.equal(await db.groupMember.count({ where: { courseMemberId: target } }), 1);
  assert.deepEqual(await readGroupInvitation(classmate.id, offeringId, token), { ...invitedSummary, remaining: 0 });
  await assert.rejects(joinStudentGroup(classmate.id, offeringId, { ...request, requestId: randomUUID() }), /已满/);
  await assert.rejects(joinStudentGroup(invitee.id, offeringId, { groupId: listed, windowId, requestId: randomUUID() }), /已加入/);

  await updateGroupRecruitment(ownerB.id, offeringId, invited, { mode: 'CLOSED', note: '', windowId });
  assert.equal(await readGroupInvitation(classmate.id, offeringId, token), null);
  const again = await updateGroupRecruitment(ownerB.id, offeringId, invited, { mode: 'INVITE', note: '再发邀请', windowId });
  assert.notEqual(again.recruitmentToken, token);
  assert.equal(await readGroupInvitation(classmate.id, offeringId, token), null);
  assert.equal((await updateGroupRecruitment(ownerB.id, offeringId, invited, {
    mode: 'INVITE', note: '改说明', windowId,
  })).recruitmentToken, again.recruitmentToken);
  await moveStudentToGroup(f.teacher.id, offeringId, f.legacy.id, target);
  assert.deepEqual(await joinStudentGroup(invitee.id, offeringId, request), { groupId: f.legacy.id });
  await assert.rejects(updateGroupRecruitment(invitee.id, offeringId, f.legacy.id, { mode: 'COURSE', note: '', windowId }), /教学团队分配/);

  await setGroupFormation(f.teacher.id, offeringId, null, windowId);
  const fresh = await open(f, 4);
  assert.deepEqual(await listRecruitingGroups(classmate.id, offeringId), []);
  assert.equal(await readGroupInvitation(classmate.id, offeringId, again.recruitmentToken!), null);
  await assert.rejects(joinStudentGroup(classmate.id, offeringId, { groupId: listed, windowId, requestId: randomUUID() }), /安排已更新/);
  await assert.rejects(joinStudentGroup(classmate.id, offeringId, { groupId: listed, windowId: fresh.id, requestId: randomUUID() }), /已失效/);
  await updateGroupRecruitment(ownerA.id, offeringId, listed, { mode: 'COURSE', note: '', windowId: fresh.id });
  await moveStudentToGroup(f.teacher.id, offeringId, f.legacy.id, (await studentId(offeringId, ownerA.id)).id);
  assert.deepEqual(await listRecruitingGroups(classmate.id, offeringId), []);
  await assert.rejects(joinStudentGroup(classmate.id, offeringId, { groupId: listed, windowId: fresh.id, requestId: randomUUID() }), /停止招募/);
});

test('同时抢最后一个名额与跨组创建不会产生超员、重复组籍或空组', async () => {
  const f = await fixture();
  const { id: offeringId } = f.offering;
  const { id: windowId } = await open(f, 3);
  const [owner, candidateA, candidateB, candidateC, candidateD] = f.students;
  const ownGroup = { name: '第一组', mode: 'COURSE' as const, note: '', windowId, requestId: randomUUID() };
  const [a, b] = await Promise.all([
    createStudentGroup(owner.id, offeringId, ownGroup), createStudentGroup(owner.id, offeringId, ownGroup),
  ]);
  assert.deepEqual(a, b);
  const firstGroup = a.groupId!;
  await assert.rejects(createStudentGroup(candidateD.id, offeringId, { ...ownGroup, requestId: randomUUID() }), /同名/);

  const joinInputs = [candidateA, candidateB].map(() => ({ groupId: firstGroup, windowId, requestId: randomUUID() }));
  const candidates = [candidateA, candidateB];
  assert.equal((await listRecruitingGroups(candidateA.id, offeringId))[0].remaining, 2);
  assert.equal((await open(f, 2, windowId)).id, windowId);
  const seat = await Promise.allSettled(candidates.map((student, index) => joinStudentGroup(student.id, offeringId, joinInputs[index])));
  assert.equal(seat.filter(result => result.status === 'fulfilled').length, 1);
  const losingSeat = seat.find(result => result.status === 'rejected');
  assert.match(String(losingSeat?.reason), /已满/);
  assert.equal(await db.groupMember.count({ where: { groupId: firstGroup, leftAt: null } }), 2);
  const winningIndex = seat.findIndex(result => result.status === 'fulfilled');
  const winningStudent = candidates[winningIndex];
  const winningMember = (await studentId(offeringId, winningStudent.id)).id;
  await moveStudentToGroup(f.teacher.id, offeringId, f.legacy.id, winningMember);
  assert.deepEqual(await joinStudentGroup(winningStudent.id, offeringId, joinInputs[winningIndex]), { groupId: f.legacy.id });
  assert.equal(await db.groupMember.count({ where: { courseMemberId: winningMember } }), 2);

  const competingCreate = { ...ownGroup, name: '同时创建的组', requestId: randomUUID() };
  const competingJoin = { groupId: firstGroup, windowId, requestId: randomUUID() };
  const competition = await Promise.allSettled([
    createStudentGroup(candidateC.id, offeringId, competingCreate), joinStudentGroup(candidateC.id, offeringId, competingJoin),
  ]);
  assert.equal(competition.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(String(competition.find(result => result.status === 'rejected')?.reason), /已加入/);
  const memberC = (await studentId(offeringId, candidateC.id)).id;
  assert.equal(await db.groupMember.count({ where: { courseMemberId: memberC, leftAt: null } }), 1);
  assert.equal(await db.group.count({ where: { id: competingCreate.requestId } }), competition[0].status === 'fulfilled' ? 1 : 0);

  await moveStudentToGroup(f.teacher.id, offeringId, f.legacy.id, (await studentId(offeringId, owner.id)).id);
  assert.deepEqual(await createStudentGroup(owner.id, offeringId, ownGroup), { groupId: f.legacy.id });
  assert.equal(await db.group.count({ where: { offeringId, name: ownGroup.name } }), 1);
});
