import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { DomainError } from '../src/lib/management';
import { getCourseFocus, saveCourseFocus, type CourseFocusInput } from '../src/lib/course-focus';

// Fixtures must never be inserted into the application's database.
assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(async () => { await db.$disconnect(); });
const denied = (promise: Promise<unknown>) => assert.rejects(promise, DomainError);
const input = (extra: Partial<CourseFocusInput> = {}): CourseFocusInput => ({
  title: '原型测试', body: '明确测试场景、观察指标与本次分工。', assignmentIds: [], resourceIds: [], ...extra,
});

async function fixture() {
  const key = randomUUID();
  const [teacher, ta, student, outsider, admin] = await Promise.all(['teacher', 'ta', 'student', 'outsider', 'admin'].map(name =>
    db.user.create({ data: { email: `${name}-${key}@test.invalid`, name, isAdmin: name === 'admin' } })));
  const course = await db.course.create({ data: { slug: key, title: '教学内容测试课' } });
  const term = await db.term.create({ data: { slug: key, name: '测试学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } });
  const offering = await db.courseOffering.create({ data: { courseId: course.id, termId: term.id, title: '测试开课', status: 'ACTIVE' } });
  const [teacherMember, taMember, studentMember] = await Promise.all([
    [teacher, 'TEACHER'], [ta, 'TA'], [student, 'STUDENT'],
  ].map(([user, role]) => db.courseMember.create({
    data: { offeringId: offering.id, userId: (user as typeof teacher).id, role: role as 'TEACHER' | 'TA' | 'STUDENT' },
  })));
  const assignments = await Promise.all((['PUBLISHED', 'DRAFT', 'ARCHIVED'] as const).map(status => db.assignment.create({
    data: { offeringId: offering.id, title: `${status}作业`, description: '测试作业说明', mode: 'INDIVIDUAL', status },
  })));
  const resources = await Promise.all((['PUBLISHED', 'DRAFT', 'ARCHIVED'] as const).map(status => db.resource.create({
    data: { offeringId: offering.id, title: `${status}资料`, body: '测试资料说明', status, visibility: 'OFFERING' },
  })));
  return { teacher, ta, student, outsider, admin, offering, teacherMember, taMember, studentMember, assignments, resources };
}

const sorted = (ids: string[]) => [...ids].sort();

test('当前教学内容由本期教师、助教或管理员自由维护，正文可独立保存且关联去重', async () => {
  const f = await fixture();
  assert.deepEqual(await getCourseFocus(f.student.id, f.offering.id), { focus: null, canEdit: false });
  const saved = await saveCourseFocus(f.ta.id, f.offering.id, input({ title: '  当前工作  ', body: '  先完成一次观察。  ' }));
  assert.equal(saved.title, '当前工作');
  assert.equal(saved.body, '先完成一次观察。');
  assert.deepEqual(saved.assignmentIds, []);
  assert.deepEqual(saved.resourceIds, []);
  assert.ok(saved.updatedAt instanceof Date);
  for (const actor of [f.teacher, f.ta, f.admin]) {
    const next = await saveCourseFocus(actor.id, f.offering.id, input({
      title: actor.name,
      assignmentIds: [f.assignments[0].id, f.assignments[0].id],
      resourceIds: [f.resources[0].id, f.resources[0].id],
    }));
    assert.equal(next.title, actor.name);
    assert.deepEqual(next.assignmentIds, [f.assignments[0].id]);
    assert.deepEqual(next.resourceIds, [f.resources[0].id]);
    assert.equal((await getCourseFocus(actor.id, f.offering.id)).canEdit, true);
  }
  assert.equal(await db.courseFocus.count({ where: { offeringId: f.offering.id } }), 1);
});

test('学生、外部用户、退出的职员不能编辑，课程读取与跨期访问仍独立鉴权', async () => {
  const f = await fixture();
  const other = await fixture();
  await saveCourseFocus(f.teacher.id, f.offering.id, input());
  for (const actor of [f.student, f.outsider, other.teacher]) await denied(saveCourseFocus(actor.id, f.offering.id, input({ title: '无权修改' })));
  for (const actor of [f.outsider, other.teacher]) await denied(getCourseFocus(actor.id, f.offering.id));
  for (const member of [f.teacherMember, f.taMember]) {
    await db.courseMember.update({ where: { id: member.id }, data: { status: 'INACTIVE' } });
    await denied(saveCourseFocus(member.userId, f.offering.id, input()));
    await denied(getCourseFocus(member.userId, f.offering.id));
  }
  assert.equal((await getCourseFocus(f.student.id, f.offering.id)).focus?.title, '原型测试');
});

test('关联仅限同一期且原子替换，错误关联不会部分改写正文或原有链接', async () => {
  const f = await fixture();
  const other = await fixture();
  const original = input({ assignmentIds: [f.assignments[0].id], resourceIds: [f.resources[0].id] });
  const before = await saveCourseFocus(f.teacher.id, f.offering.id, original);
  for (const invalid of [
    { assignmentIds: [other.assignments[0].id] },
    { resourceIds: [other.resources[0].id] },
    { assignmentIds: [f.assignments[1].id, 'missing-assignment'] },
    { resourceIds: [f.resources[1].id, 'missing-resource'] },
  ]) {
    await denied(saveCourseFocus(f.teacher.id, f.offering.id, { ...original, ...invalid, title: '不应保存', body: '不应保存的正文' }));
    assert.deepEqual((await getCourseFocus(f.teacher.id, f.offering.id)).focus, before);
  }
  const next = await saveCourseFocus(f.teacher.id, f.offering.id, input({ title: '下一步', assignmentIds: [f.assignments[1].id], resourceIds: [f.resources[1].id] }));
  assert.deepEqual(next.assignmentIds, [f.assignments[1].id]);
  assert.deepEqual(next.resourceIds, [f.resources[1].id]);
  const plain = await saveCourseFocus(f.teacher.id, f.offering.id, input({ body: '' }));
  assert.deepEqual(plain.assignmentIds, []);
  assert.deepEqual(plain.resourceIds, []);
  assert.equal(plain.body, '');
});

test('教学内容遵守目标记录可读边界：学生不能读草稿，但已结束作业仍可回看', async () => {
  const f = await fixture();
  await saveCourseFocus(f.teacher.id, f.offering.id, input({
    assignmentIds: f.assignments.map(row => row.id), resourceIds: f.resources.map(row => row.id),
  }));
  const student = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  assert.deepEqual(sorted(student.assignmentIds), sorted([f.assignments[0].id, f.assignments[2].id]));
  assert.deepEqual(student.resourceIds, [f.resources[0].id]);
  const ta = (await getCourseFocus(f.ta.id, f.offering.id)).focus!;
  assert.deepEqual(sorted(ta.assignmentIds), sorted(f.assignments.map(row => row.id)));
  assert.deepEqual(ta.resourceIds, [f.resources[0].id]);
  const teacher = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  assert.deepEqual(sorted(teacher.resourceIds), sorted(f.resources.map(row => row.id)));
  await db.assignment.update({ where: { id: f.assignments[0].id }, data: { status: 'ARCHIVED' } });
  await db.resource.update({ where: { id: f.resources[0].id }, data: { status: 'ARCHIVED' } });
  const withdrawn = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  assert.deepEqual(sorted(withdrawn.assignmentIds), sorted([f.assignments[0].id, f.assignments[2].id]));
  assert.deepEqual(withdrawn.resourceIds, []);
  assert.equal(withdrawn.body, input().body);
});

test('助教保存只替换自己可读取的资料，隐藏草稿关联不泄漏也不被意外删除', async () => {
  const f = await fixture();
  await saveCourseFocus(f.teacher.id, f.offering.id, input({ resourceIds: f.resources.map(row => row.id) }));
  const before = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  await denied(saveCourseFocus(f.ta.id, f.offering.id, input({ title: '猜测隐藏资料', resourceIds: [f.resources[1].id] })));
  assert.deepEqual((await getCourseFocus(f.teacher.id, f.offering.id)).focus, before);
  const taSaved = await saveCourseFocus(f.ta.id, f.offering.id, input({ title: '助教更新正文', resourceIds: [] }));
  assert.deepEqual(taSaved.resourceIds, []);
  const teacherRead = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  assert.equal(teacherRead.title, '助教更新正文');
  assert.deepEqual(sorted(teacherRead.resourceIds), sorted([f.resources[1].id, f.resources[2].id]));
  await db.resource.update({ where: { id: f.resources[1].id }, data: { status: 'PUBLISHED' } });
  assert.deepEqual((await getCourseFocus(f.ta.id, f.offering.id)).focus!.resourceIds, [f.resources[1].id]);
  await saveCourseFocus(f.ta.id, f.offering.id, input({ resourceIds: [] }));
  assert.deepEqual((await getCourseFocus(f.teacher.id, f.offering.id)).focus!.resourceIds, [f.resources[2].id]);
});

test('筹备期允许职员编写，归档后所有写入只读但保留教学内容', async () => {
  const f = await fixture();
  await db.courseOffering.update({ where: { id: f.offering.id }, data: { status: 'DRAFT' } });
  await saveCourseFocus(f.ta.id, f.offering.id, input({ title: '筹备说明' }));
  await db.courseOffering.update({ where: { id: f.offering.id }, data: { status: 'ARCHIVED' } });
  const before = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  for (const actor of [f.teacher, f.ta, f.admin]) {
    assert.equal((await getCourseFocus(actor.id, f.offering.id)).canEdit, false);
    await denied(saveCourseFocus(actor.id, f.offering.id, input({ title: '不可写入' })));
  }
  assert.deepEqual((await getCourseFocus(f.student.id, f.offering.id)).focus, before);
});

test('服务验证标题正文和关联格式，数据库复合外键阻止绕过服务的跨期开课链接', async () => {
  const f = await fixture();
  const other = await fixture();
  for (const invalid of [{ title: ' ' }, { title: '长'.repeat(101) }, { body: '长'.repeat(12001) }, { assignmentIds: [''] }]) {
    await denied(saveCourseFocus(f.teacher.id, f.offering.id, input(invalid)));
  }
  assert.equal((await getCourseFocus(f.teacher.id, f.offering.id)).focus, null);
  await saveCourseFocus(f.teacher.id, f.offering.id, input());
  await assert.rejects(db.courseFocusAssignment.create({ data: { offeringId: f.offering.id, assignmentId: other.assignments[0].id } }));
  await assert.rejects(db.courseFocusResource.create({ data: { offeringId: f.offering.id, resourceId: other.resources[0].id } }));
  assert.equal(await db.courseFocusAssignment.count({ where: { offeringId: f.offering.id } }), 0);
  assert.equal(await db.courseFocusResource.count({ where: { offeringId: f.offering.id } }), 0);
});
