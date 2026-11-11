import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { db } from '../src/lib/db';
import { DomainError } from '../src/lib/management';
import { createCourseSubpage, getCourseSubpage } from '../src/lib/course-subpages';
import { applyCoursePublicationPlan, previewCoursePublicationPlan } from '../src/lib/course-publication-plan';
import { createResource, getCourseResourceFile } from '../src/lib/resource-service';
import { createAssignment } from '../src/lib/teaching';
import { assignmentMaterialLink } from '../src/lib/assignment-material-links';
import type { CourseDocument } from '../src/lib/course-document';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(() => db.$disconnect());

async function fixture() {
  const key = randomUUID();
  const offering = await db.courseOffering.create({ data: {
    course: { create: { slug: key, title: '发布边界审计' } },
    term: { create: { slug: key, name: '审计学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } },
    title: '虚构发布课堂', status: 'ACTIVE',
  } });
  const [teacher, ta, student] = await Promise.all((['TEACHER', 'TA', 'STUDENT'] as const).map(role =>
    db.courseMember.create({ data: { offering: { connect: { id: offering.id } }, role, user: { create: { name: role, email: `${key}-${role}@test.invalid` } } } }),
  ));
  const page = await createCourseSubpage(teacher.userId, offering.id, '待发布课次');
  const resource = await createResource(teacher.userId, offering.id, {
    title: '不应提前公开的提纲', body: '', url: '', status: 'DRAFT', file: new File(['隔离测试提纲'], '提纲.txt'),
  });
  const assignment = await createAssignment(teacher.userId, offering.id, {
    title: '待发布任务', description: assignmentMaterialLink(offering.id, resource), status: 'DRAFT', mode: 'INDIVIDUAL', dueAt: null,
  });
  const document: CourseDocument = { version: 1, blocks: [{
    id: randomUUID(), type: 'courseRecord', props: { kind: 'assignments', recordId: assignment.id, display: 'card' }, children: [],
  }] };
  const input = { title: '待发布课次', revision: page.revision, document };
  const plan = await previewCoursePublicationPlan(teacher.userId, offering.id, page.id, input);
  return { offeringId: offering.id, teacher, ta, student, page, resource, assignment, input, plan };
}

test('发布计划形成后归档或停用作者，正文与选中草稿均不得写入', async () => {
  for (const change of ['archive', 'inactive'] as const) {
    const f = await fixture();
    if (change === 'archive') await db.courseOffering.update({ where: { id: f.offeringId }, data: { status: 'ARCHIVED' } });
    else await db.courseMember.update({ where: { id: f.teacher.id }, data: { status: 'INACTIVE' } });
    await assert.rejects(applyCoursePublicationPlan(f.teacher.userId, f.offeringId, f.page.id, f.input, f.plan.key,
      f.plan.records.map(record => record.key)), DomainError);
    assert.equal((await db.assignment.findUniqueOrThrow({ where: { id: f.assignment.id } })).status, 'DRAFT');
    assert.equal((await db.resource.findUniqueOrThrow({ where: { id: f.resource.id } })).status, 'DRAFT');
    assert.equal((await db.courseSubpage.findUniqueOrThrow({ where: { id: f.page.id } })).publishedAt, null);
    assert.equal(await db.assignmentRevision.count({ where: { assignmentId: f.assignment.id } }), 1);
  }
});

test('同一发布计划并发确认仅一次写入，不重复产生作业发布修订', async () => {
  const f = await fixture();
  const publish = () => applyCoursePublicationPlan(f.teacher.userId, f.offeringId, f.page.id, f.input,
    f.plan.key, f.plan.records.map(record => record.key));
  const results = await Promise.allSettled([publish(), publish()]);
  assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.page).length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(await db.assignmentRevision.count({ where: { assignmentId: f.assignment.id, status: 'PUBLISHED' } }), 1);
  assert.equal((await db.resource.findUniqueOrThrow({ where: { id: f.resource.id } })).revision, f.resource.revision + 1);
  assert.ok((await getCourseSubpage(f.student.userId, f.offeringId, f.page.id)).page?.publishedAt);
  assert.ok(await getCourseResourceFile(f.student.userId, f.offeringId, f.resource.id));
});

test('教师的发布计划不能由助教复用来发布保护资料或带出资料标识', async () => {
  const f = await fixture();
  const result = await applyCoursePublicationPlan(f.ta.userId, f.offeringId, f.page.id, f.input,
    f.plan.key, f.plan.records.map(record => record.key));
  assert.equal(result.page, undefined);
  assert.ok(result.plan?.hasProtectedReferences);
  assert.ok(!JSON.stringify(result).includes(f.resource.id));
  assert.ok(!JSON.stringify(result).includes(f.resource.title));
  assert.equal((await db.resource.findUniqueOrThrow({ where: { id: f.resource.id } })).status, 'DRAFT');
  assert.equal((await db.assignment.findUniqueOrThrow({ where: { id: f.assignment.id } })).status, 'DRAFT');
  assert.equal((await db.courseSubpage.findUniqueOrThrow({ where: { id: f.page.id } })).publishedAt, null);
});
