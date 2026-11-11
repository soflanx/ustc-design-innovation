import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { canCreateCourse, createCourse } from '../src/lib/course-creation';
import { DomainError, createOffering } from '../src/lib/management';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(async () => { await db.$disconnect(); });

async function account(label: string, isAdmin = false) {
  return db.user.create({ data: { name: label, email: `${randomUUID()}@test.invalid`, isAdmin } });
}

test('管理员可创建空课程并成为负责人，后续可开设学期', async () => {
  const admin = await account('管理员', true);
  assert.equal(await canCreateCourse(admin.id), true);
  const course = await createCourse(admin.id, { requestId: randomUUID(), title: ' 从零开始 ', description: ' 新课程 ' });
  assert.equal(course.title, '从零开始');
  assert.equal(course.description, '新课程');
  assert.deepEqual((await db.courseStaff.findMany({ where: { courseId: course.id } })).map(staff => [staff.userId, staff.role]), [[admin.id, 'TEACHER']]);
  assert.equal(await db.courseOffering.count({ where: { courseId: course.id } }), 0);
  const offering = await createOffering(admin.id, { courseId: course.id, termName: '2030 秋', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01'), description: '' });
  assert.equal(offering.status, 'DRAFT');
  assert.deepEqual((await db.courseMember.findMany({ where: { offeringId: offering.id } })).map(member => [member.userId, member.role]), [[admin.id, 'TEACHER']]);
});

test('只有长期教师关系可用于创建课程，学生、助教和陌生用户均不能创建', async () => {
  const [teacher, ta, student, outsider] = await Promise.all(['教师', '助教', '学生', '陌生账号'].map(label => account(label)));
  const current = await db.course.create({ data: { title: '已有课程', slug: randomUUID(), staff: { create: { userId: teacher.id, role: 'TEACHER' } } } });
  const offering = await createOffering(teacher.id, { courseId: current.id, termName: '2035 秋', startDate: new Date('2035-09-01'), endDate: new Date('2036-01-01'), description: '' });
  await db.courseMember.createMany({ data: [{ offeringId: offering.id, userId: ta.id, role: 'TA' }, { offeringId: offering.id, userId: student.id, role: 'STUDENT' }] });
  assert.equal(await canCreateCourse(teacher.id), true);
  const created = await createCourse(teacher.id, { requestId: randomUUID(), title: '教师的新课程', description: '' });
  assert.ok(created.id);
  for (const actor of [ta, student, outsider]) {
    assert.equal(await canCreateCourse(actor.id), false);
    await assert.rejects(createCourse(actor.id, { requestId: randomUUID(), title: '越权课程', description: '' }), DomainError);
  }
  assert.equal(await canCreateCourse('missing-user'), false);
  assert.equal(await db.course.count({ where: { title: '越权课程' } }), 0);
});

test('相同创建请求并发重试只建一门课，改内容重用请求会被拒绝', async () => {
  const admin = await account('幂等管理员', true);
  const input = { requestId: randomUUID(), title: '只创建一次', description: '保留描述' };
  const [first, second] = await Promise.all([createCourse(admin.id, input), createCourse(admin.id, input)]);
  assert.equal(first.id, second.id);
  assert.equal(await db.course.count({ where: { id: first.id } }), 1);
  assert.equal(await db.courseStaff.count({ where: { courseId: first.id } }), 1);
  await assert.rejects(createCourse(admin.id, { ...input, title: '不同的标题' }), DomainError);
  const otherAdmin = await account('另一个管理员', true);
  const independent = await createCourse(otherAdmin.id, input);
  assert.notEqual(independent.id, first.id);
});

test('空名称、超长正文和伪造请求标识不会写入课程', async () => {
  const admin = await account('校验管理员', true);
  const count = await db.course.count();
  const input = { requestId: randomUUID(), title: '课程', description: '' };
  for (const patch of [{ title: '  ' }, { title: 'a'.repeat(101) }, { description: 'a'.repeat(2001) }, { requestId: '../invalid' }]) {
    await assert.rejects(createCourse(admin.id, { ...input, ...patch }));
  }
  assert.equal(await db.course.count(), count);
});

test('无课程的演示教师仅在本机开发演示环境可创建首课，不能扩展到普通账号', async () => {
  const demo = await db.user.create({ data: { id: 'demo-teacher', name: '演示教师', email: 'demo-teacher@test.invalid', isDemo: true } });
  const plainDemo = await db.user.create({ data: { id: 'demo-ta', name: '演示助教', email: 'demo-ta@test.invalid', isDemo: true } });
  const original = { NODE_ENV: process.env.NODE_ENV, APP_URL: process.env.APP_URL, DEMO_AUTH_ENABLED: process.env.DEMO_AUTH_ENABLED };
  const environment = process.env as Record<string, string | undefined>;
  try {
    Object.assign(environment, { NODE_ENV: 'development', APP_URL: 'http://127.0.0.1:4174', DEMO_AUTH_ENABLED: 'true' });
    assert.equal(await canCreateCourse(demo.id), true);
    assert.equal(await canCreateCourse(plainDemo.id), false);
    await assert.rejects(createCourse(plainDemo.id, { requestId: randomUUID(), title: '助教越权', description: '' }), DomainError);
    environment.NODE_ENV = 'production';
    assert.equal(await canCreateCourse(demo.id), false);
    await assert.rejects(createCourse(demo.id, { requestId: randomUUID(), title: '生产环境越权', description: '' }), DomainError);
    environment.NODE_ENV = 'development';
    environment.APP_URL = 'https://example.com';
    assert.equal(await canCreateCourse(demo.id), false);
    environment.APP_URL = 'http://127.0.0.1:4174';
    await db.user.update({ where: { id: demo.id }, data: { isDemo: false } });
    assert.equal(await canCreateCourse(demo.id), false);
    await db.user.update({ where: { id: demo.id }, data: { isDemo: true } });
    const first = await createCourse(demo.id, { requestId: randomUUID(), title: '真正从零创建', description: '' });
    assert.ok(first.id);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: demo.id } })).isAdmin, false);
  } finally {
    for (const key of Object.keys(original) as Array<keyof typeof original>) {
      if (original[key] === undefined) delete environment[key];
      else environment[key] = original[key];
    }
  }
});
