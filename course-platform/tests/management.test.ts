import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { canManageOffering, canViewGroup, canViewOffering } from '../src/lib/policy';
import { DomainError, OfferingIntroductionConflictError, createOffering, setOfferingStatus, saveOfferingIntroduction, addCourseMember, createGroup, moveStudentToGroup, assignTa, endTaAssignment, saveGroupPage } from '../src/lib/management';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(async () => { await db.$disconnect(); });

async function fixture() {
  const key = randomUUID();
  const users = await Promise.all(['teacher', 'student', 'ta', 'outsider'].map(name => db.user.create({ data: { email: `${name}-${key}@test.invalid`, name } })));
  const [teacher, student, ta, outsider] = users;
  const course = await db.course.create({ data: { slug: key, title: '隔离测试课程', staff: { create: { userId: teacher.id } } } });
  const term = await db.term.create({ data: { slug: key, name: '隔离测试学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } });
  const offering = await createOffering(teacher.id, { courseId: course.id, termId: term.id, description: '测试' });
  const studentMember = await addCourseMember(teacher.id, offering.id, student.id, 'STUDENT');
  const taMember = await addCourseMember(teacher.id, offering.id, ta.id, 'TA');
  const a = await createGroup(teacher.id, offering.id, 'A组', '');
  const b = await createGroup(teacher.id, offering.id, 'B组', '');
  return { teacher, student, ta, outsider, course, term, offering, studentMember, taMember, a, b };
}

const denied = (promise: Promise<unknown>) => assert.rejects(promise, DomainError);

test('只更新本学期公开介绍，保持通用介绍、往期归档和成员教学安排各自独立', async () => {
  const f = await fixture();
  await db.course.update({ where: { id: f.course.id }, data: { description: '长期课程介绍' } });
  const prior = await createOffering(f.teacher.id, {
    courseId: f.course.id, termName: '往期', startDate: new Date('2029-09-01'), endDate: new Date('2030-01-01'), description: '往期访客介绍',
  });
  await setOfferingStatus(f.teacher.id, prior.id, 'ARCHIVED');
  const focus = await db.courseFocus.create({ data: {
    offeringId: f.offering.id, title: '本课成员教学安排', publishedAt: new Date(),
    draftTitle: '教学团队草稿', draftDocument: { version: 1, blocks: [] },
  } });
  const first = await saveOfferingIntroduction(f.teacher.id, f.offering.id, '测试', '  学习观察\n\n  再做原型。  ');
  assert.deepEqual(first, { description: '学习观察\n\n  再做原型。', status: 'DRAFT' });
  await setOfferingStatus(f.teacher.id, f.offering.id, 'ACTIVE');
  const admin = await db.user.create({ data: { email: `${randomUUID()}@test.invalid`, name: '管理员', isAdmin: true } });
  const cleared = await saveOfferingIntroduction(admin.id, f.offering.id, first.description, ' \n ');
  assert.deepEqual(cleared, { description: '', status: 'ACTIVE' });
  assert.equal((await db.courseOffering.findUniqueOrThrow({ where: { id: f.offering.id } })).description, '');
  assert.equal((await db.course.findUniqueOrThrow({ where: { id: f.course.id } })).description, '长期课程介绍');
  assert.deepEqual(await db.courseOffering.findUniqueOrThrow({ where: { id: prior.id }, select: { description: true, status: true } }), {
    description: '往期访客介绍', status: 'ARCHIVED',
  });
  assert.deepEqual(await db.courseFocus.findUniqueOrThrow({ where: { offeringId: f.offering.id } }), focus);
});

test('两份旧表竞争保存只有一份成功；冲突带回最新值，重试同结果和清空均幂等', async () => {
  const f = await fixture();
  const save = (expected: string, next: string) => saveOfferingIntroduction(f.teacher.id, f.offering.id, expected, next);
  const results = await Promise.allSettled([save('测试', '甲介绍'), save('测试', '乙介绍')]);
  const success = results.find(result => result.status === 'fulfilled');
  const failure = results.find(result => result.status === 'rejected');
  assert.ok(success && failure);
  const latest = success.value.description;
  assert.ok(failure.reason instanceof OfferingIntroductionConflictError);
  assert.equal(failure.reason.currentDescription, latest);
  assert.equal((await save('测试', latest)).description, latest);
  assert.equal((await save(latest, '')).description, '');
  await assert.rejects(save(latest, '另一份编辑'), error => error instanceof OfferingIntroductionConflictError && error.currentDescription === '');
  assert.equal((await save(latest, '')).description, '');
});

test('拒绝越权和归档旧表，不回显冲突内容；允许较长的旧基准修订到 2000 字以内', async () => {
  const f = await fixture(), other = await fixture();
  for (const user of [f.student, f.ta, other.teacher]) {
    await assert.rejects(saveOfferingIntroduction(user.id, f.offering.id, '过时基准', '改动'), error =>
      error instanceof DomainError && !(error instanceof OfferingIntroductionConflictError));
  }
  const legacy = '旧'.repeat(2010);
  await db.courseOffering.update({ where: { id: f.offering.id }, data: { description: legacy } });
  await denied(saveOfferingIntroduction(f.teacher.id, f.offering.id, legacy, '新'.repeat(2001)));
  await denied(saveOfferingIntroduction(f.teacher.id, f.offering.id, legacy, null as unknown as string));
  await denied(saveOfferingIntroduction(f.teacher.id, f.offering.id, legacy, '无效\0正文'));
  const shortened = '新'.repeat(2000);
  assert.equal((await saveOfferingIntroduction(f.teacher.id, f.offering.id, legacy, shortened)).description, shortened);
  await setOfferingStatus(f.teacher.id, f.offering.id, 'ARCHIVED');
  await assert.rejects(saveOfferingIntroduction(f.teacher.id, f.offering.id, legacy, '归档旧编辑'), /已归档/);
  await setOfferingStatus(f.teacher.id, f.offering.id, 'ACTIVE');
  await db.courseMember.update({ where: { offeringId_userId: { offeringId: f.offering.id, userId: f.teacher.id } }, data: { status: 'INACTIVE' } });
  await assert.rejects(saveOfferingIntroduction(f.teacher.id, f.offering.id, legacy, '名单已停用'), /没有管理/);
  assert.equal((await db.courseOffering.findUniqueOrThrow({ where: { id: f.offering.id } })).description, shortened);
});

test('权限边界：学生仅看本组，助教可查看但不能管理，失效成员不再可见', () => {
  const student = { role: 'STUDENT', status: 'ACTIVE' } as const;
  const ta = { role: 'TA', status: 'ACTIVE' } as const;
  assert.equal(canViewOffering(false, student), true);
  assert.equal(canViewGroup(false, student, true), true);
  assert.equal(canViewGroup(false, student, false), false);
  assert.equal(canViewGroup(false, ta, false), true);
  assert.equal(canManageOffering(false, ta), false);
  assert.equal(canManageOffering(false, student), false);
  assert.equal(canViewGroup(false, { role: 'STUDENT', status: 'INACTIVE' }, true), false);
  assert.equal(canViewOffering(false, null), false);
  assert.equal(canManageOffering(true, null), true);
});

test('新学期开课只继承课程教师，不复制旧学生与分组；重复开课拒绝', async () => {
  const f = await fixture();
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.studentMember.id);
  const term = await db.term.create({ data: { slug: randomUUID(), name: '下一学期', startDate: new Date('2031-09-01'), endDate: new Date('2032-01-01') } });
  const next = await createOffering(f.teacher.id, { courseId: f.course.id, termId: term.id, description: '新开课' });
  assert.equal(next.status, 'DRAFT');
  const members = await db.courseMember.findMany({ where: { offeringId: next.id } });
  assert.deepEqual(members.map(m => [m.userId, m.role]), [[f.teacher.id, 'TEACHER']]);
  assert.equal(await db.group.count({ where: { offeringId: next.id } }), 0);
  await denied(createOffering(f.teacher.id, { courseId: f.course.id, termId: term.id, description: '重复' }));
  assert.equal(await db.courseOffering.count({ where: { courseId: f.course.id, termId: term.id } }), 1);
});

test('学生和助教无法借管理服务开课、改状态、加人、调组或分配助教', async () => {
  const f = await fixture();
  for (const actor of [f.student, f.ta, f.outsider]) {
    await denied(createOffering(actor.id, { courseId: f.course.id, termId: f.term.id, description: '' }));
    await denied(setOfferingStatus(actor.id, f.offering.id, 'ARCHIVED'));
    await denied(addCourseMember(actor.id, f.offering.id, f.outsider.id, 'TEACHER'));
    await denied(createGroup(actor.id, f.offering.id, '越权组', ''));
    await denied(moveStudentToGroup(actor.id, f.offering.id, f.a.id, f.studentMember.id));
    await denied(assignTa(actor.id, f.offering.id, f.a.id, f.taMember.id));
  }
  assert.equal((await db.courseOffering.findUniqueOrThrow({ where: { id: f.offering.id } })).status, 'DRAFT');
  assert.equal(await db.groupMember.count({ where: { offeringId: f.offering.id } }), 0);
  assert.equal(await db.courseMember.count({ where: { offeringId: f.offering.id } }), 3);
});

test('调组保留历史离组时间，且数据库阻止第二个有效组籍', async () => {
  const f = await fixture();
  const original = await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.studentMember.id);
  const latest = await moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.studentMember.id);
  const history = await db.groupMember.findUniqueOrThrow({ where: { id: original.id } });
  assert.ok(history.leftAt);
  assert.equal(history.groupId, f.a.id);
  assert.ok(history.leftAt.getTime() <= latest.joinedAt.getTime());
  assert.equal(await db.groupMember.count({ where: { courseMemberId: f.studentMember.id, leftAt: null } }), 1);
  await assert.rejects(db.groupMember.create({ data: { offeringId: f.offering.id, groupId: f.a.id, courseMemberId: f.studentMember.id } }));
  await denied(moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.studentMember.id));
});

test('跨学期伪造小组或成员ID在服务与数据库两层均拒绝', async () => {
  const f = await fixture();
  const other = await fixture();
  await denied(moveStudentToGroup(f.teacher.id, f.offering.id, other.a.id, f.studentMember.id));
  await denied(moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, other.studentMember.id));
  await denied(assignTa(f.teacher.id, f.offering.id, other.a.id, f.taMember.id));
  await denied(assignTa(f.teacher.id, f.offering.id, f.a.id, other.taMember.id));
  await denied(saveGroupPage(f.teacher.id, f.offering.id, other.a.id, '越课', '', 0));
  await assert.rejects(db.groupMember.create({ data: { offeringId: f.offering.id, groupId: other.a.id, courseMemberId: f.studentMember.id } }));
  await assert.rejects(db.groupMember.create({ data: { offeringId: f.offering.id, groupId: f.a.id, courseMemberId: other.studentMember.id } }));
  assert.equal(await db.groupMember.count({ where: { offeringId: f.offering.id } }), 0);
});

test('学生可编辑本组主页，不能编辑其他组；助教查看权不赋予编辑权', async () => {
  const f = await fixture();
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.studentMember.id);
  const page = await saveGroupPage(f.student.id, f.offering.id, f.a.id, '本组进展', '观察与发现', 0);
  assert.equal(page.body, '观察与发现');
  await denied(saveGroupPage(f.student.id, f.offering.id, f.b.id, '冒名', '', 0));
  await denied(saveGroupPage(f.ta.id, f.offering.id, f.a.id, '助教冒名', '', page.revision));
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.studentMember.id);
  await denied(saveGroupPage(f.student.id, f.offering.id, f.a.id, '离组后编辑', '', page.revision));
  assert.equal((await db.groupPage.findUniqueOrThrow({ where: { groupId: f.a.id } })).title, '本组进展');
});

test('归档阻止成员、小组、助教和主页变更，保留已有内容', async () => {
  const f = await fixture();
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.studentMember.id);
  const assignment = await assignTa(f.teacher.id, f.offering.id, f.a.id, f.taMember.id);
  const page = await saveGroupPage(f.student.id, f.offering.id, f.a.id, '归档前', '留存', 0);
  await setOfferingStatus(f.teacher.id, f.offering.id, 'ARCHIVED');
  await denied(addCourseMember(f.teacher.id, f.offering.id, f.outsider.id, 'STUDENT'));
  await denied(createGroup(f.teacher.id, f.offering.id, '新组', ''));
  await denied(moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.studentMember.id));
  await denied(assignTa(f.teacher.id, f.offering.id, f.b.id, f.taMember.id));
  await denied(endTaAssignment(f.teacher.id, f.offering.id, assignment.id));
  await denied(saveGroupPage(f.student.id, f.offering.id, f.a.id, '覆盖归档', '', page.revision));
  assert.equal((await db.groupPage.findUniqueOrThrow({ where: { groupId: f.a.id } })).body, '留存');
  assert.equal((await db.taGroupAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).endedAt, null);
});

test('学生不能被指派为助教，助教不能作为学生加入小组', async () => {
  const f = await fixture();
  await denied(assignTa(f.teacher.id, f.offering.id, f.a.id, f.studentMember.id));
  await denied(moveStudentToGroup(f.teacher.id, f.offering.id, f.a.id, f.taMember.id));
  await assert.rejects(db.taGroupAssignment.create({ data: { offeringId: f.offering.id, groupId: f.a.id, courseMemberId: f.studentMember.id } }));
  await assert.rejects(db.groupMember.create({ data: { offeringId: f.offering.id, groupId: f.a.id, courseMemberId: f.taMember.id } }));
  assert.equal(await db.taGroupAssignment.count({ where: { offeringId: f.offering.id } }), 0);
});
