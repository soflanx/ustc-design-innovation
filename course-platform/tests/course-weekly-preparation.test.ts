import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { collectCourseReferences, createMarkdownBlock, type CourseDocument } from '../src/lib/course-document';
import { createCourseSubpage, getCourseSubpage, saveCourseSubpage } from '../src/lib/course-subpages';
import { db } from '../src/lib/db';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(() => db.$disconnect());

const document = (body: string): CourseDocument => ({ version: 1, blocks: [createMarkdownBlock('body', body)] });

async function fixture() {
  const key = randomUUID();
  const offering = await db.courseOffering.create({ data: {
    title: '新课准备测试', status: 'ACTIVE',
    course: { create: { slug: key, title: '课程' } },
    term: { create: { slug: key, name: '测试学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } },
  } });
  const [teacher, ta, student] = await Promise.all((['TEACHER', 'TA', 'STUDENT'] as const).map(role => db.user.create({
    data: { email: role + key + '@test.invalid', name: role, memberships: { create: { offeringId: offering.id, role } } },
  })));
  return { offeringId: offering.id, teacher: teacher.id, ta: ta.id, student: student.id };
}

test('新课次保存正文和已发布原件引用，重试沿用同一草稿', async () => {
  const { offeringId, ta, student } = await fixture();
  const other = await fixture();
  const dueAt = new Date('2030-10-10T12:00:00Z');
  const assignment = await db.assignment.create({ data: { offeringId, title: '跨周作业', mode: 'GROUP', dueAt, status: 'PUBLISHED' } });
  const resource = await db.resource.create({ data: { offeringId, title: '原讲义', body: '原件', status: 'PUBLISHED' } });
  const hidden = await db.resource.create({ data: { offeringId, title: '本期草稿资料', body: '待整理', status: 'DRAFT' } });
  const foreign = await db.resource.create({ data: { offeringId: other.offeringId, title: '其他期讲义', body: '其他期原件', status: 'PUBLISHED' } });
  const starter = { body: '讨论两次观察。\n\n准备分组展示。', assignmentId: assignment.id, resourceId: resource.id };
  await assert.rejects(createCourseSubpage(ta, offeringId, '本周', randomUUID(), { ...starter, resourceId: foreign.id }), /本期已发布的资料/);
  await assert.rejects(createCourseSubpage(ta, offeringId, '本周', randomUUID(), { ...starter, resourceId: hidden.id }), /本期已发布的资料/);

  const requestId = randomUUID();
  const lesson = await createCourseSubpage(ta, offeringId, '本周', requestId, starter);
  assert.equal((await getCourseSubpage(student, offeringId, lesson.id)).page, null);
  assert.deepEqual(lesson.draft?.document.blocks[0], createMarkdownBlock('lesson-body', starter.body));
  const refs = collectCourseReferences(lesson.draft!.document);
  assert.deepEqual(refs.assignmentIds, [assignment.id]);
  assert.deepEqual(refs.resourceIds, [resource.id]);
  const saved = (await saveCourseSubpage(ta, offeringId, lesson.id, { title: '改过的标题', document: document('已继续编辑'), revision: lesson.revision }, false)).page!;
  await db.resource.update({ where: { id: resource.id }, data: { status: 'ARCHIVED' } });
  const retry = await createCourseSubpage(ta, offeringId, '本周', requestId, starter);
  assert.equal(retry.id, lesson.id);
  assert.equal(retry.revision, saved.revision);
  assert.equal(retry.draft?.title, '改过的标题');
  await assert.rejects(createCourseSubpage(ta, offeringId, '本周', requestId, { ...starter, body: '另一份正文' }), /新建请求已使用/);
  assert.deepEqual((await db.assignment.findUniqueOrThrow({ where: { id: assignment.id } })).dueAt, dueAt);
  assert.equal(await db.assignment.count({ where: { offeringId } }), 1);
  assert.equal(await db.courseSubpage.count({ where: { offeringId } }), 1);
});
