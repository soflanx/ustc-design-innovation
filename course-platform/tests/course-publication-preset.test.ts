import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { User } from '@prisma/client';
import { db } from '../src/lib/db';
import { DomainError } from '../src/lib/management';
import { getPublishablePresetKeys, publishPresetCourse } from '../src/lib/course-offering-publication';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(async () => { await db.$disconnect(); });

let admin: User, otherAdmin: User, teacher: User, ta: User, student: User, outsider: User;
let autumnThinkingId: string, autumnPracticeId: string, springThinkingId: string, springPracticeId: string;

before(async () => {
  [admin, otherAdmin, teacher, ta, student, outsider] = await Promise.all([
    ['发布管理员', true], ['另一管理员', true], ['另一门课教师', false], ['助教', false], ['学生', false], ['陌生账号', false],
  ].map(([name, isAdmin]) => db.user.create({ data: { name: String(name), isAdmin: Boolean(isAdmin), email: `${randomUUID()}@test.invalid` } })));
  const otherCourse = await db.course.create({ data: { slug: randomUUID(), title: '另一门课程', staff: { create: { userId: teacher.id, role: 'TEACHER' } } } });
  const term = await db.term.create({ data: { slug: randomUUID(), name: '角色验证学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } });
  const offering = await db.courseOffering.create({ data: { courseId: otherCourse.id, termId: term.id, title: '角色验证' } });
  await db.courseMember.createMany({ data: [{ offeringId: offering.id, userId: ta.id, role: 'TA' }, { offeringId: offering.id, userId: student.id, role: 'STUDENT' }] });
});

test('空目录不会让学生、助教或陌生账号获得固定课程发布权', async () => {
  assert.deepEqual(await getPublishablePresetKeys('missing-user'), []);
  assert.deepEqual(await getPublishablePresetKeys(admin.id), ['thinking', 'practice']);
  for (const user of [ta, student, outsider]) {
    assert.deepEqual(await getPublishablePresetKeys(user.id), []);
    await assert.rejects(publishPresetCourse(user.id, { preset: 'thinking', termKey: '2026-autumn' }), DomainError);
  }
  assert.equal(await db.course.count({ where: { slug: { in: ['design-thinking', 'design-practice'] } } }), 0);
});

test('思维与实践一键发布为进行中，两课共用官方学期，并发重试只建一次', async () => {
  const first = await Promise.all(Array.from({ length: 3 }, () => publishPresetCourse(admin.id, { preset: 'thinking', termKey: '2026-autumn' })));
  assert.equal(new Set(first.map(offering => offering.id)).size, 1);
  const thinking = first[0];
  const practice = await publishPresetCourse(admin.id, { preset: 'practice', termKey: '2026-autumn' });
  autumnThinkingId = thinking.id; autumnPracticeId = practice.id;
  assert.equal(thinking.status, 'ACTIVE');
  assert.equal(practice.status, 'ACTIVE');
  assert.equal(thinking.termId, practice.termId);
  assert.match(thinking.title, /^设计创新思维 · 2026 年秋季学期$/);
  assert.match(practice.title, /^设计创新实践Ⅰ · 2026 年秋季学期$/);
  const term = await db.term.findUniqueOrThrow({ where: { id: thinking.termId } });
  assert.equal(term.slug, '2026-autumn');
  assert.equal(term.startDate.toISOString(), '2026-08-30T16:00:00.000Z');
  assert.equal(term.endDate.toISOString(), '2027-01-15T15:59:59.999Z');
  assert.deepEqual((await db.courseMember.findMany({ where: { offeringId: thinking.id } })).map(member => [member.userId, member.role]), [[admin.id, 'TEACHER']]);
  assert.equal(await db.course.count({ where: { slug: { in: ['design-thinking', 'design-practice'] } } }), 2);
  assert.equal(await db.courseOffering.count({ where: { courseId: thinking.courseId, termId: thinking.termId } }), 1);
  assert.equal(await db.assignment.count({ where: { offeringId: thinking.id } }), 0);
  assert.equal(await db.resource.count({ where: { offeringId: thinking.id } }), 0);
  assert.equal(await db.group.count({ where: { offeringId: thinking.id } }), 0);
});

test('春季自动生成实践Ⅱ，长期教师加入新期；管理员不会冒充既有课程教师', async () => {
  const thinkingCourse = await db.course.findUniqueOrThrow({ where: { slug: 'design-thinking' } });
  await db.courseStaff.create({ data: { courseId: thinkingCourse.id, userId: teacher.id, role: 'TEACHER' } });
  const thinking = await publishPresetCourse(admin.id, { preset: 'thinking', termKey: '2026-spring' });
  const practice = await publishPresetCourse(otherAdmin.id, { preset: 'practice', termKey: '2026-spring' });
  springThinkingId = thinking.id; springPracticeId = practice.id;
  assert.match(practice.title, /^设计创新实践Ⅱ · 2026 年春季学期$/);
  assert.equal(thinking.termId, practice.termId);
  assert.equal((await db.course.findUniqueOrThrow({ where: { slug: 'design-practice' } })).title, '设计创新实践');
  assert.deepEqual((await db.courseMember.findMany({ where: { offeringId: thinking.id } })).map(member => member.userId).sort(), [admin.id, teacher.id].sort());
  assert.equal(await db.courseMember.count({ where: { offeringId: practice.id, userId: otherAdmin.id } }), 0);
  assert.equal(await db.courseStaff.count({ where: { courseId: practice.courseId, userId: otherAdmin.id } }), 0);
  assert.equal(await db.courseMember.count({ where: { offeringId: thinking.id, role: { in: ['STUDENT', 'TA'] } } }), 0);
});

test('重复发布保留内容、成员与归档/筹备状态，不自动重新开放旧课', async () => {
  await db.group.create({ data: { offeringId: autumnThinkingId, name: '保留的小组' } });
  await db.courseOffering.update({ where: { id: autumnThinkingId }, data: { status: 'ARCHIVED', description: '保留这次教学安排' } });
  const originalMembers = await db.courseMember.count({ where: { offeringId: autumnThinkingId } });
  const existing = await publishPresetCourse(admin.id, { preset: 'thinking', termKey: '2026-autumn' });
  assert.equal(existing.id, autumnThinkingId);
  assert.equal(existing.status, 'ARCHIVED');
  assert.equal(existing.description, '保留这次教学安排');
  assert.equal(await db.group.count({ where: { offeringId: autumnThinkingId } }), 1);
  assert.equal(await db.courseMember.count({ where: { offeringId: autumnThinkingId } }), originalMembers);
  // A teacher added to the long-term course later does not silently join old offerings.
  assert.equal(await db.courseMember.count({ where: { offeringId: autumnThinkingId, userId: teacher.id } }), 0);
  await db.courseOffering.update({ where: { id: springPracticeId }, data: { status: 'DRAFT' } });
  assert.equal((await publishPresetCourse(admin.id, { preset: 'practice', termKey: '2026-spring' })).status, 'DRAFT');
});

test('另一课教师不能接管固定课程，管理员能读取但不被添加为负责人', async () => {
  assert.deepEqual(await getPublishablePresetKeys(teacher.id), ['thinking']);
  await assert.rejects(publishPresetCourse(teacher.id, { preset: 'practice', termKey: '2026-autumn' }), DomainError);
  const practice = await db.courseOffering.findUniqueOrThrow({ where: { id: autumnPracticeId } });
  await db.courseMember.create({ data: { offeringId: practice.id, userId: teacher.id, role: 'TEACHER' } });
  await assert.rejects(publishPresetCourse(teacher.id, { preset: 'practice', termKey: '2026-autumn' }), DomainError);
  assert.equal(await db.courseStaff.count({ where: { courseId: practice.courseId, userId: teacher.id } }), 0);
  assert.equal((await publishPresetCourse(otherAdmin.id, { preset: 'thinking', termKey: '2026-spring' })).id, springThinkingId);
});

test('未知校历或任意客户端元数据不会创建学期与开课', async () => {
  const counts = [await db.course.count(), await db.term.count(), await db.courseOffering.count()];
  await assert.rejects(publishPresetCourse(admin.id, { preset: 'thinking', termKey: '2027-spring' }), /校历尚未同步/);
  await assert.rejects(publishPresetCourse(admin.id, { preset: 'thinking', termKey: '2026-summer' }));
  await assert.rejects(publishPresetCourse(admin.id, { preset: 'custom', termKey: '2026-autumn' } as never));
  await assert.rejects(publishPresetCourse(admin.id, { preset: 'thinking', termKey: '2026-autumn', title: '任意标题', startDate: '2000-01-01' } as never));
  assert.deepEqual([await db.course.count(), await db.term.count(), await db.courseOffering.count()], counts);
});
