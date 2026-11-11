import { confirmedSubmissionInput } from './submission-fixture';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { DomainError } from '../src/lib/management';
import { getCourseFocus, saveCourseDocument, saveCourseDocumentDraft, type CourseDocumentInput } from '../src/lib/course-focus';
import { saveCoursePageAssignment, saveCoursePageResource, type CoursePageAssignmentInput, type CoursePageResourceInput } from '../src/lib/course-page-records';
import { readCourseRecordCatalogEntry } from '../src/lib/course-record-catalog';
import { getAssignmentDetail, getAssignmentIndex, submitAssignment } from '../src/lib/teaching';
import { getCourseResource, getCourseResourceReferences } from '../src/lib/resource-service';
import { assignmentMaterialLink, splitAssignmentMaterialLinks } from '../src/lib/assignment-material-links';
import type { CourseBlock } from '../src/lib/course-document';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(async () => { await db.$disconnect(); });
const denied = (promise: Promise<unknown>) => assert.rejects(promise, DomainError);
const paragraph = (text = '公开教学说明'): CourseBlock => ({ id: randomUUID(), type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] });
const reference = (kind: 'assignments' | 'resources', recordId: string): CourseBlock => ({ id: randomUUID(), type: 'courseRecord', props: { kind, recordId, display: 'card' }, children: [] });
const page = (...blocks: CourseBlock[]): CourseDocumentInput => ({ title: '课程首页', revision: 0, document: { version: 1, blocks } });
const assignment = (extra: Partial<CoursePageAssignmentInput['assignment']> = {}): CoursePageAssignmentInput['assignment'] => ({ title: '原型测试', description: '提交观察与证据', mode: 'INDIVIDUAL', status: 'PUBLISHED', dueAt: '', ...extra });
const resource = (extra: Partial<CoursePageResourceInput['resource']> = {}): CoursePageResourceInput['resource'] => ({ title: '访谈指引', body: '记录行为。', url: '', status: 'PUBLISHED', ...extra });

async function fixture() {
  const key = randomUUID();
  const [teacher, ta, student, outsider, admin] = await Promise.all(['teacher', 'ta', 'student', 'outsider', 'admin'].map(name => db.user.create({ data: { email: `${name}-${key}@test.invalid`, name, isAdmin: name === 'admin' } })));
  const course = await db.course.create({ data: { slug: key, title: '页面内独立记录测试' } });
  const term = await db.term.create({ data: { slug: key, name: '测试学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } });
  const offering = await db.courseOffering.create({ data: { courseId: course.id, termId: term.id, title: '测试开课', status: 'ACTIVE' } });
  for (const [user, role] of [[teacher, 'TEACHER'], [ta, 'TA'], [student, 'STUDENT']] as const) await db.courseMember.create({ data: { offeringId: offering.id, userId: user.id, role } });
  return { teacher, ta, student, outsider, admin, offering };
}

test('主页入口创建正式记录不要求或创建页面，也不擅自插入公开引用', async () => {
  const f = await fixture();
  const saved = await saveCoursePageAssignment(f.teacher.id, f.offering.id, { requestId: randomUUID(), assignment: assignment({ dueAt: '2030-11-15T23:59', maxScore: 75 }) });
  assert.equal(saved.assignment.dueAt?.toISOString(), '2030-11-15T15:59:00.000Z');
  assert.equal(saved.assignment.revision, 1);
  assert.equal(saved.assignment.maxScore, 75);
  assert.equal((await getAssignmentIndex(f.student.id, f.offering.id)).assignments[0].id, saved.assignment.id);
  const materials = await saveCoursePageResource(f.teacher.id, f.offering.id, { requestId: randomUUID(), resource: resource() });
  assert.equal(materials.resource.revision, 1);
  assert.equal((await getCourseResource(f.student.id, f.offering.id, materials.resource.id)).resource?.body, '记录行为。');
  assert.equal((await getCourseFocus(f.teacher.id, f.offering.id)).focus, null);
  assert.equal(await db.courseFocusAssignment.count({ where: { offeringId: f.offering.id } }), 0);
  assert.equal(await db.courseFocusResource.count({ where: { offeringId: f.offering.id } }), 0);
});

test('作业中的提纲随提交要求留存，资料入口按当前课堂成员和发布状态读取', async () => {
  const f = await fixture(), other = await fixture();
  const offeringId = f.offering.id;
  const file = new File(['记录受访者的回答。'], '访谈提纲.txt');
  const { resource: material } = await saveCoursePageResource(f.teacher.id, offeringId, {
    requestId: randomUUID(), resource: resource({ title: '访谈提纲', file }),
  });
  const description = '参照提纲完成访谈。\n\n' + assignmentMaterialLink(offeringId, material);
  const { assignment: task } = await saveCoursePageAssignment(f.teacher.id, offeringId, {
    requestId: randomUUID(), assignment: assignment({ description }),
  });
  const first = await getAssignmentDetail(f.student.id, offeringId, task.id);
  const ids = splitAssignmentMaterialLinks(first.assignment.description, offeringId).flatMap(part => part.resourceId ? [part.resourceId] : []);
  assert.deepEqual(ids, [material.id]);
  assert.deepEqual(await getCourseResourceReferences(f.student.id, offeringId, ids), [
    { id: material.id, offeringId, url: null, file: { name: file.name } },
  ]);
  assert.deepEqual(await getCourseResourceReferences(other.student.id, other.offering.id, ids), []);
  await denied(getCourseResourceReferences(f.outsider.id, offeringId, ids));

  const submission = await submitAssignment(f.student.id, offeringId, task.id, await confirmedSubmissionInput(f.student.id, offeringId, task.id));
  await saveCoursePageAssignment(f.teacher.id, offeringId, {
    expectedRevision: task.revision, assignment: assignment({ id: task.id, description: '下一轮改为自由访谈。' }),
  });
  await saveCoursePageResource(f.teacher.id, offeringId, {
    expectedRevision: material.revision, statusOnly: true, resource: resource({ id: material.id, status: 'ARCHIVED' }),
  });
  const after = await getAssignmentDetail(f.student.id, offeringId, task.id);
  assert.notEqual(after.assignment.description, description);
  assert.equal(after.versions.find(version => version.id === submission.id)?.assignmentRevision?.description, description);
  assert.deepEqual(await getCourseResourceReferences(f.student.id, offeringId, ids), []);
});

test('记录结束和资料撤回独立于页面版本，不保存、清空或发布已有主页草稿', async () => {
  const f = await fixture();
  const a = (await saveCoursePageAssignment(f.teacher.id, f.offering.id, { requestId: randomUUID(), assignment: assignment() })).assignment;
  const r = (await saveCoursePageResource(f.teacher.id, f.offering.id, { requestId: randomUUID(), resource: resource() })).resource;
  const published = await saveCourseDocument(f.teacher.id, f.offering.id, page(paragraph(), reference('assignments', a.id), reference('resources', r.id)));
  await saveCourseDocumentDraft(f.teacher.id, f.offering.id, { ...page(paragraph('不能顺带发布的说明'), reference('assignments', a.id)), title: '未完成标题', revision: published.revision });
  const before = await db.courseFocus.findUniqueOrThrow({ where: { offeringId: f.offering.id } });
  const beforeA = await db.courseFocusAssignment.findMany({ where: { offeringId: f.offering.id } });
  const beforeR = await db.courseFocusResource.findMany({ where: { offeringId: f.offering.id } });
  const ended = await saveCoursePageAssignment(f.teacher.id, f.offering.id, { expectedRevision: a.revision, statusOnly: true, assignment: assignment({ id: a.id, status: 'ARCHIVED', title: '不能覆盖的旧表单' }) });
  const withdrawn = await saveCoursePageResource(f.teacher.id, f.offering.id, { expectedRevision: r.revision, statusOnly: true, resource: resource({ id: r.id, status: 'ARCHIVED', body: '不能覆盖的旧正文' }) });
  assert.equal(ended.assignment.status, 'ARCHIVED');
  assert.equal(withdrawn.resource.status, 'ARCHIVED');
  assert.deepEqual(await db.courseFocus.findUniqueOrThrow({ where: { offeringId: f.offering.id } }), before);
  assert.deepEqual(await db.courseFocusAssignment.findMany({ where: { offeringId: f.offering.id } }), beforeA);
  assert.deepEqual(await db.courseFocusResource.findMany({ where: { offeringId: f.offering.id } }), beforeR);
  const student = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  assert.ok(!JSON.stringify(student).includes('不能顺带发布'));
  assert.deepEqual(student.assignmentIds, [a.id]);
  assert.deepEqual(student.resourceIds, []);
});

test('作业用自身版本拒绝旧表单；仅状态操作不覆盖旧正文也不被坏日期阻塞', async () => {
  const f = await fixture();
  const original = (await saveCoursePageAssignment(f.teacher.id, f.offering.id, { requestId: randomUUID(), assignment: assignment() })).assignment;
  const current = (await saveCoursePageAssignment(f.teacher.id, f.offering.id, { expectedRevision: original.revision, assignment: assignment({ id: original.id, title: '新标题', description: '新要求', maxScore: 40 }) })).assignment;
  await denied(saveCoursePageAssignment(f.teacher.id, f.offering.id, { expectedRevision: original.revision, assignment: assignment({ id: original.id, title: '旧表单' }) }));
  await denied(saveCoursePageAssignment(f.teacher.id, f.offering.id, { expectedRevision: original.revision, statusOnly: true, assignment: assignment({ id: original.id, status: 'ARCHIVED' }) }));
  const ended = (await saveCoursePageAssignment(f.teacher.id, f.offering.id, { expectedRevision: current.revision, statusOnly: true, assignment: assignment({ id: original.id, title: '', description: '旧要求', mode: 'GROUP', dueAt: '不是日期', maxScore: 100, status: 'ARCHIVED' }) })).assignment;
  assert.equal(ended.title, '新标题'); assert.equal(ended.description, '新要求'); assert.equal(ended.mode, 'INDIVIDUAL'); assert.equal(ended.maxScore, 40);
  assert.equal(ended.revision, current.revision + 1);
  assert.equal(ended.status, 'ARCHIVED');
});

test('资料自身版本拒绝旧保存，撤回忽略旧正文和坏网址并保留首次发布时间', async () => {
  const f = await fixture();
  const original = (await saveCoursePageResource(f.teacher.id, f.offering.id, { requestId: randomUUID(), resource: resource() })).resource;
  const current = (await saveCoursePageResource(f.teacher.id, f.offering.id, { expectedRevision: original.revision, resource: resource({ id: original.id, title: '新资料标题', body: '新说明', url: 'https://example.invalid/new' }) })).resource;
  await denied(saveCoursePageResource(f.teacher.id, f.offering.id, { expectedRevision: original.revision, resource: resource({ id: original.id }) }));
  await denied(saveCoursePageResource(f.teacher.id, f.offering.id, { expectedRevision: original.revision, statusOnly: true, resource: resource({ id: original.id, status: 'ARCHIVED' }) }));
  const withdrawn = (await saveCoursePageResource(f.teacher.id, f.offering.id, { expectedRevision: current.revision, statusOnly: true, resource: resource({ id: original.id, title: '', body: '旧正文', url: 'javascript:alert(1)', status: 'ARCHIVED' }) })).resource;
  assert.equal(withdrawn.title, '新资料标题'); assert.equal(withdrawn.body, '新说明'); assert.equal(withdrawn.url, 'https://example.invalid/new');
  assert.equal(withdrawn.revision, current.revision + 1);
  assert.equal(withdrawn.firstPublishedAt?.getTime(), original.firstPublishedAt?.getTime());
  for (const user of [f.ta, f.student]) assert.equal((await getCourseResource(user.id, f.offering.id, original.id)).resource, null);
});

test('同一创建请求重复和并发重试只产生一条记录，不匹配正文或创建人不能复用', async () => {
  const f = await fixture();
  const a = { requestId: randomUUID(), assignment: assignment({ status: 'DRAFT' }) };
  const assignments = await Promise.all([saveCoursePageAssignment(f.teacher.id, f.offering.id, a), saveCoursePageAssignment(f.teacher.id, f.offering.id, a)]);
  assert.equal(assignments[0].assignment.id, assignments[1].assignment.id);
  assert.equal((await saveCoursePageAssignment(f.teacher.id, f.offering.id, a)).assignment.id, assignments[0].assignment.id);
  await denied(saveCoursePageAssignment(f.teacher.id, f.offering.id, { ...a, assignment: assignment({ title: '不同请求内容', status: 'DRAFT' }) }));
  await denied(saveCoursePageAssignment(f.admin.id, f.offering.id, a));
  const r = { requestId: randomUUID(), resource: resource({ status: 'DRAFT' }) };
  const resources = await Promise.all([saveCoursePageResource(f.teacher.id, f.offering.id, r), saveCoursePageResource(f.teacher.id, f.offering.id, r)]);
  assert.equal(resources[0].resource.id, resources[1].resource.id);
  assert.equal((await saveCoursePageResource(f.teacher.id, f.offering.id, r)).resource.id, resources[0].resource.id);
  await denied(saveCoursePageResource(f.teacher.id, f.offering.id, { ...r, resource: resource({ body: '不同内容', status: 'DRAFT' }) }));
  await denied(saveCoursePageResource(f.admin.id, f.offering.id, r));
  assert.equal(await db.assignment.count({ where: { offeringId: f.offering.id } }), 1);
  assert.equal(await db.resource.count({ where: { offeringId: f.offering.id } }), 1);
});

test('创建必需幂等标识，编辑必需记录版本，无效输入不遗留记录', async () => {
  const f = await fixture();
  await denied(saveCoursePageAssignment(f.teacher.id, f.offering.id, { assignment: assignment() }));
  await denied(saveCoursePageResource(f.teacher.id, f.offering.id, { resource: resource() }));
  await assert.rejects(saveCoursePageAssignment(f.teacher.id, f.offering.id, { requestId: randomUUID(), assignment: assignment({ dueAt: '2030-02-30T12:00' }) }));
  await assert.rejects(saveCoursePageResource(f.teacher.id, f.offering.id, { requestId: randomUUID(), resource: resource({ url: 'javascript:alert(1)' }) }));
  assert.equal(await db.assignment.count({ where: { offeringId: f.offering.id } }), 0);
  assert.equal(await db.resource.count({ where: { offeringId: f.offering.id } }), 0);
  const a = (await saveCoursePageAssignment(f.teacher.id, f.offering.id, { requestId: randomUUID(), assignment: assignment() })).assignment;
  const r = (await saveCoursePageResource(f.teacher.id, f.offering.id, { requestId: randomUUID(), resource: resource() })).resource;
  for (const statusOnly of [false, true]) {
    await denied(saveCoursePageAssignment(f.teacher.id, f.offering.id, { statusOnly, assignment: assignment({ id: a.id }) }));
    await denied(saveCoursePageResource(f.teacher.id, f.offering.id, { statusOnly, resource: resource({ id: r.id }) }));
  }
  assert.equal((await db.assignment.findUniqueOrThrow({ where: { id: a.id } })).revision, a.revision);
  assert.equal((await db.resource.findUniqueOrThrow({ where: { id: r.id } })).revision, r.revision);
});

test('主页可编辑权不授予记录管理权，跨期开课与归档写入继续拒绝', async () => {
  const f = await fixture(), other = await fixture();
  for (const actor of [f.ta, f.student, f.outsider]) {
    await denied(saveCoursePageAssignment(actor.id, f.offering.id, { requestId: randomUUID(), assignment: assignment() }));
    await denied(saveCoursePageResource(actor.id, f.offering.id, { requestId: randomUUID(), resource: resource() }));
  }
  const a = (await saveCoursePageAssignment(f.teacher.id, f.offering.id, { requestId: randomUUID(), assignment: assignment() })).assignment;
  const r = (await saveCoursePageResource(f.teacher.id, f.offering.id, { requestId: randomUUID(), resource: resource() })).resource;
  for (const statusOnly of [false, true]) {
    await denied(saveCoursePageAssignment(other.teacher.id, other.offering.id, { expectedRevision: a.revision, statusOnly, assignment: assignment({ id: a.id, status: 'ARCHIVED' }) }));
    await denied(saveCoursePageResource(other.teacher.id, other.offering.id, { expectedRevision: r.revision, statusOnly, resource: resource({ id: r.id, status: 'ARCHIVED' }) }));
    for (const actor of [f.ta, f.student]) {
      await denied(saveCoursePageAssignment(actor.id, f.offering.id, { expectedRevision: a.revision, statusOnly, assignment: assignment({ id: a.id }) }));
      await denied(saveCoursePageResource(actor.id, f.offering.id, { expectedRevision: r.revision, statusOnly, resource: resource({ id: r.id }) }));
    }
  }
  await db.courseOffering.update({ where: { id: f.offering.id }, data: { status: 'ARCHIVED' } });
  for (const actor of [f.teacher, f.admin]) {
    await denied(saveCoursePageAssignment(actor.id, f.offering.id, { expectedRevision: a.revision, statusOnly: true, assignment: assignment({ id: a.id, status: 'ARCHIVED' }) }));
    await denied(saveCoursePageResource(actor.id, f.offering.id, { expectedRevision: r.revision, statusOnly: true, resource: resource({ id: r.id, status: 'ARCHIVED' }) }));
  }
  assert.equal((await db.assignment.findUniqueOrThrow({ where: { id: a.id } })).status, 'PUBLISHED');
  assert.equal((await db.resource.findUniqueOrThrow({ where: { id: r.id } })).status, 'PUBLISHED');
});

test('主页作业取消要求原因并保留提交及对应要求版本，重新开放仍沿用同一作业', async () => {
  const f = await fixture();
  const a = (await saveCoursePageAssignment(f.teacher.id, f.offering.id, { requestId: randomUUID(), assignment: assignment() })).assignment;
  const version = await submitAssignment(f.student.id, f.offering.id, a.id, await confirmedSubmissionInput(f.student.id, f.offering.id, a.id, '测试结果'));
  await denied(saveCoursePageAssignment(f.teacher.id, f.offering.id, { expectedRevision: a.revision, statusOnly: true, assignment: assignment({ id: a.id, status: 'CANCELLED' }) }));
  const cancelled = (await saveCoursePageAssignment(f.teacher.id, f.offering.id, { expectedRevision: a.revision, statusOnly: true, assignment: assignment({ id: a.id, status: 'CANCELLED', cancellationReason: '课程安排调整' }) })).assignment;
  const detail = await getAssignmentDetail(f.student.id, f.offering.id, a.id);
  assert.equal(detail.assignment.cancellationReason, '课程安排调整');
  assert.equal(detail.canSubmit, false); assert.equal(detail.versions[0].id, version.id);
  assert.equal(detail.versions[0].assignmentRevision?.description, a.description);
  const reopened = (await saveCoursePageAssignment(f.teacher.id, f.offering.id, { expectedRevision: cancelled.revision, statusOnly: true, assignment: assignment({ id: a.id, status: 'PUBLISHED' }) })).assignment;
  assert.equal(reopened.id, a.id); assert.equal(reopened.cancellationReason, null);
  assert.equal(await db.assignment.count({ where: { offeringId: f.offering.id } }), 1);
});

test('单条catalog与主页展示同源，返回可序列化版本字段且不泄漏教师表单数据', async () => {
  const f = await fixture();
  const a = (await saveCoursePageAssignment(f.teacher.id, f.offering.id, { requestId: randomUUID(), assignment: assignment({ dueAt: '2030-11-15T23:59', maxScore: 25 }) })).assignment;
  const r = (await saveCoursePageResource(f.teacher.id, f.offering.id, { requestId: randomUUID(), resource: resource({ status: 'DRAFT' }) })).resource;
  const teacherA = await readCourseRecordCatalogEntry(f.teacher.id, f.offering.id, 'assignments', a.id);
  assert.equal(teacherA.visibilityStatus, 'PUBLISHED');
  assert.equal(teacherA.assignment?.revision, a.revision);
  assert.equal(teacherA.assignment?.maxScore, 25);
  assert.equal(teacherA.assignment?.dueAt, '2030-11-15T23:59');
  assert.equal(JSON.parse(JSON.stringify(teacherA)).assignment.maxScore, 25);
  for (const actor of [f.student, f.ta]) assert.equal((await readCourseRecordCatalogEntry(actor.id, f.offering.id, 'assignments', a.id)).assignment, undefined);
  const teacherR = await readCourseRecordCatalogEntry(f.teacher.id, f.offering.id, 'resources', r.id);
  assert.equal(teacherR.visibilityStatus, 'DRAFT'); assert.equal(teacherR.resource?.revision, r.revision);
  for (const actor of [f.student, f.ta, f.outsider]) await denied(readCourseRecordCatalogEntry(actor.id, f.offering.id, 'resources', r.id));
  await saveCoursePageAssignment(f.teacher.id, f.offering.id, { expectedRevision: a.revision, statusOnly: true, assignment: assignment({ id: a.id, status: 'CANCELLED', cancellationReason: '无需继续提交' }) });
  const studentA = await readCourseRecordCatalogEntry(f.student.id, f.offering.id, 'assignments', a.id);
  assert.equal(studentA.visibilityStatus, 'CANCELLED'); assert.match(studentA.detail!, /无需继续提交/);
  assert.equal(studentA.assignment, undefined);
});
