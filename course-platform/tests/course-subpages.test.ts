import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { DomainError } from '../src/lib/management';
import { createCourseSubpage, getCourseSubpage, getGroupActivitySource, listCourseSubpages, saveCourseSubpage, withdrawCourseSubpage } from '../src/lib/course-subpages';
import type { CourseBlock, CourseDocument } from '../src/lib/course-document';

import { assignmentMaterialLink } from '../src/lib/assignment-material-links';
import { applyCoursePublicationPlan, previewCoursePublicationPlan } from '../src/lib/course-publication-plan';
import { createResource, getCourseResource, getCourseResourceFile, updateResource } from '../src/lib/resource-service';
import { createAssignment, getAssignmentDetail } from '../src/lib/teaching';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(() => db.$disconnect());

const doc = (...blocks: CourseBlock[]): CourseDocument => ({ version: 1, blocks });
const prose = (source: string): CourseBlock => ({ id: randomUUID(), type: 'markdown', props: {}, content: [{ type: 'text', text: source, styles: {} }], children: [] });
const ref = (kind: 'assignments' | 'resources' | 'groups', recordId: string): CourseBlock => ({ id: randomUUID(), type: 'courseRecord', props: { kind, recordId, display: 'card' }, children: [] });

async function fixture() {
  const key = randomUUID();
  const course = await db.course.create({ data: { slug: key, title: '页面测试' } });
  const term = await db.term.create({ data: { slug: key, name: '测试学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } });
  const offering = await db.courseOffering.create({ data: { courseId: course.id, termId: term.id, title: '页面测试', status: 'ACTIVE' } });
  const users = await Promise.all((['TEACHER', 'TA', 'STUDENT'] as const).map(role => db.user.create({
    data: { email: role + key + '@test.invalid', name: role, memberships: { create: { offeringId: offering.id, role } } },
  })));
  return { offeringId: offering.id, teacher: users[0].id, ta: users[1].id, student: users[2].id };
}

test('子页面有稳定地址，一页的发布、重命名草稿、另一页的草稿互不影响', async () => {
  const { offeringId, teacher, ta, student } = await fixture();
  const page = await createCourseSubpage(teacher, offeringId, '工作坊');
  await createCourseSubpage(ta, offeringId, '教师备课中');
  assert.equal((await getCourseSubpage(student, offeringId, page.id)).page, null);
  assert.deepEqual((await listCourseSubpages(student, offeringId)).pages, []);
  const src = '## 现场观察\n\n- 记录路口\n- 比较两次原型\n';
  const body = doc(prose(src));
  const published = (await saveCourseSubpage(ta, offeringId, page.id, { title: '工作坊', document: body, revision: page.revision }, true)).page!;
  assert.ok(published.publishedAt);
  await saveCourseSubpage(teacher, offeringId, page.id, { title: '未公开新标题', document: doc(prose('稿内材料')), revision: published.revision }, false);
  const studentList = (await listCourseSubpages(student, offeringId)).pages;
  assert.deepEqual(studentList.map(item => [item.id, item.title, item.hasDraft]), [[page.id, '工作坊', false]]);
  assert.equal(studentList[0].publishedTitle, '工作坊');
  const read = (await getCourseSubpage(student, offeringId, page.id)).page!;
  assert.deepEqual(read.document, body);
  assert.ok(!JSON.stringify(read).includes('未公开新标题') && !('draft' in read));
  assert.equal((await getCourseSubpage(teacher, offeringId, page.id)).page?.draft?.title, '未公开新标题');
  const teacherList = (await listCourseSubpages(teacher, offeringId)).pages;
  assert.deepEqual(teacherList.map(item => [item.title, item.publishedTitle]), [['未公开新标题', '工作坊'], ['教师备课中', null]]);
});

test('重试新建返回原页，不覆盖已保存草稿，同时保存同一版本只有一份成功', async () => {
  const { offeringId, teacher, ta } = await fixture(), requestId = randomUUID();
  const page = await createCourseSubpage(teacher, offeringId, '工作坊', requestId);
  const write = (user: string, title: string) => saveCourseSubpage(user, offeringId, page.id, { title, document: doc(prose(title)), revision: page.revision }, false);
  const concurrent = await Promise.allSettled([write(ta, '甲编辑'), write(teacher, '乙编辑')]);
  assert.equal(concurrent.filter(item => item.status === 'fulfilled').length, 1);
  const saved = await createCourseSubpage(teacher, offeringId, '工作坊', requestId);
  assert.equal(saved.id, page.id);
  assert.ok(['甲编辑', '乙编辑'].includes(saved.draft!.title));
  assert.equal(saved.revision, page.revision + 1);
  await assert.rejects(createCourseSubpage(teacher, offeringId, '其他标题', requestId), DomainError);
  assert.equal((await listCourseSubpages(ta, offeringId)).pages.length, 1);
});

test('从小组返回活动时按课堂及当前身份读取标题，学生只读公开版本', async () => {
  const f = await fixture(), other = await fixture();
  const page = await createCourseSubpage(f.teacher, f.offeringId, '教师备课');
  const student = { id: f.student, isAdmin: false };
  const ta = { id: f.ta, isAdmin: false };
  const readStudent = () => getGroupActivitySource(student, f.offeringId, page.id, 'STUDENT');
  assert.equal(await readStudent(), null);
  assert.deepEqual(await getGroupActivitySource(ta, f.offeringId, page.id, 'TA'), { id: page.id, title: '教师备课' });
  const published = (await saveCourseSubpage(f.ta, f.offeringId, page.id, { title: '工作坊', document: doc(prose('活动要求')), revision: page.revision }, true)).page!;
  const editing = (await saveCourseSubpage(f.teacher, f.offeringId, page.id, { title: '尚未发布的新标题', document: doc(), revision: published.revision }, false)).page!;
  assert.deepEqual(await readStudent(), { id: page.id, title: '工作坊' });
  assert.deepEqual(await getGroupActivitySource(ta, f.offeringId, page.id, 'TA'), { id: page.id, title: '工作坊' });
  assert.equal(await getGroupActivitySource({ id: other.ta, isAdmin: false }, other.offeringId, page.id, 'TA'), null);
  assert.equal(await getGroupActivitySource({ id: other.ta, isAdmin: false }, f.offeringId, page.id, 'TA'), null);
  assert.equal(await getGroupActivitySource(student, f.offeringId, undefined, 'STUDENT'), null);
  await withdrawCourseSubpage(f.teacher, f.offeringId, page.id, editing.revision);
  assert.equal(await readStudent(), null);
  assert.equal(await getGroupActivitySource(student, f.offeringId, page.id, 'TA'), null);
  assert.deepEqual(await getGroupActivitySource(ta, f.offeringId, page.id, 'TA'), { id: page.id, title: '尚未发布的新标题' });
});

test('学生与非成员不可创建或改写，归档只读，页面与教学引用均限制在本期', async () => {
  const f = await fixture(), other = await fixture();
  const page = await createCourseSubpage(f.teacher, f.offeringId, '归属测试');
  const foreign = await db.assignment.create({ data: { offeringId: other.offeringId, mode: 'GROUP', status: 'PUBLISHED', title: '其他班' } });
  const input = { title: '编辑', document: doc(ref('assignments', foreign.id)), revision: page.revision };
  await assert.rejects(saveCourseSubpage(f.teacher, f.offeringId, page.id, input, false), /本学期/);
  await assert.rejects(saveCourseSubpage(other.teacher, other.offeringId, page.id, input, false), /不存在或不可访问/);
  assert.equal((await getCourseSubpage(other.teacher, other.offeringId, page.id)).page, null);
  await assert.rejects(getCourseSubpage(other.student, f.offeringId, page.id), DomainError);
  await assert.rejects(createCourseSubpage(f.student, f.offeringId, '尝试创建'), DomainError);
  await assert.rejects(saveCourseSubpage(f.student, f.offeringId, page.id, { ...input, document: doc() }, true), DomainError);
  await db.courseOffering.update({ where: { id: f.offeringId }, data: { status: 'ARCHIVED' } });
  assert.equal((await getCourseSubpage(f.ta, f.offeringId, page.id)).canEdit, false);
  assert.equal((await getCourseSubpage(f.ta, f.offeringId, page.id)).page?.draft?.title, '归属测试');
  await assert.rejects(createCourseSubpage(f.ta, f.offeringId, '归档写入'), DomainError);
  await assert.rejects(saveCourseSubpage(f.teacher, f.offeringId, page.id, { ...input, document: doc() }, true), DomainError);
});

test('发布复核只暴露可读关联，状态改变使首次确认失效，助教保存保留隐藏资料', async () => {
  const f = await fixture();
  const page = await createCourseSubpage(f.teacher, f.offeringId, '作品选读');
  const assignment = await db.assignment.create({ data: { offeringId: f.offeringId, mode: 'INDIVIDUAL', status: 'DRAFT', title: '未公开作业' } });
  const hidden = await db.resource.create({ data: { offeringId: f.offeringId, status: 'DRAFT', title: '教师资料', body: '隐藏说明' } });
  await saveCourseSubpage(f.teacher, f.offeringId, page.id, { title: '作品选读', revision: page.revision, document: doc(ref('assignments', assignment.id), ref('resources', hidden.id)) }, false);
  const ta = (await getCourseSubpage(f.ta, f.offeringId, page.id)).page!;
  assert.ok(ta.draft!.document.blocks.some(block => block.type === 'protected'));
  assert.ok(!JSON.stringify(ta).includes(hidden.id));
  const input = { title: ta.draft!.title, revision: ta.revision, document: doc(...ta.draft!.document.blocks.filter(block => block.type !== 'protected'), prose('新段落')) };
  const first = (await saveCourseSubpage(f.ta, f.offeringId, page.id, input, true)).review!;
  assert.equal(first.assignments.draft, 1);
  assert.equal(first.resources.total, 0);
  assert.equal(first.hasProtectedReferences, true);
  assert.ok(!first.key.includes(hidden.id));
  await db.assignment.update({ where: { id: assignment.id }, data: { status: 'PUBLISHED' } });
  const second = (await saveCourseSubpage(f.ta, f.offeringId, page.id, input, true, first.key)).review!;
  assert.equal(second.assignments.published, 1);
  assert.notEqual(first.key, second.key);
  assert.equal((await getCourseSubpage(f.student, f.offeringId, page.id)).page, null);
  assert.ok((await saveCourseSubpage(f.ta, f.offeringId, page.id, input, true, second.key)).page!.publishedAt);
  const visible = (await getCourseSubpage(f.student, f.offeringId, page.id)).page!;
  assert.ok(JSON.stringify(visible).includes(assignment.id));
  assert.ok(!JSON.stringify(visible).includes(hidden.id));
  assert.ok(JSON.stringify((await getCourseSubpage(f.teacher, f.offeringId, page.id)).page).includes(hidden.id));
});

test('撤回即时隐藏目录与直链；无草稿保留公开内容，有更新草稿保留编辑且能原址重新发布', async () => {
  const { teacher, ta, student, offeringId } = await fixture();
  const initial = await createCourseSubpage(teacher, offeringId, '活动');
  const published = (await saveCourseSubpage(teacher, offeringId, initial.id, { title: '活动', document: doc(prose('集合地点')), revision: initial.revision }, true)).page!;
  await assert.rejects(withdrawCourseSubpage(student, offeringId, initial.id, published.revision), DomainError);
  await assert.rejects(withdrawCourseSubpage(ta, offeringId, initial.id, initial.revision), /已更新/);
  const withdrawn = await withdrawCourseSubpage(ta, offeringId, initial.id, published.revision);
  assert.deepEqual(withdrawn.draft?.document, published.document);
  assert.equal(withdrawn.draft?.title, published.title);
  assert.equal(withdrawn.publishedAt, null);
  assert.equal((await getCourseSubpage(student, offeringId, initial.id)).page, null);
  assert.deepEqual((await listCourseSubpages(student, offeringId)).pages, []);
  const restored = (await saveCourseSubpage(teacher, offeringId, initial.id, { title: withdrawn.draft!.title, document: withdrawn.draft!.document, revision: withdrawn.revision }, true)).page!;
  assert.equal((await getCourseSubpage(student, offeringId, initial.id)).page?.id, initial.id);
  const next = (await saveCourseSubpage(ta, offeringId, initial.id, { title: '更新草稿', document: doc(prose('新地点')), revision: restored.revision }, false)).page!;
  await assert.rejects(withdrawCourseSubpage(teacher, offeringId, initial.id, restored.revision), /已更新/);
  const withDraft = await withdrawCourseSubpage(teacher, offeringId, initial.id, next.revision);
  assert.deepEqual(withDraft.draft, next.draft);
  const again = (await saveCourseSubpage(ta, offeringId, initial.id, { ...withDraft.draft!, revision: withDraft.revision }, true)).page!;
  await db.courseOffering.update({ where: { id: offeringId }, data: { status: 'ARCHIVED' } });
  await assert.rejects(withdrawCourseSubpage(teacher, offeringId, initial.id, again.revision), /归档/);
  assert.equal((await getCourseSubpage(student, offeringId, initial.id)).page?.title, '更新草稿');
});


test('发布计划无写入，仅选择的草稿随课次发布，要求修订及未选文件均保留', async () => {
  const { offeringId, teacher, student } = await fixture();
  const subpage = await createCourseSubpage(teacher, offeringId, '本周安排');
  const file = await createResource(teacher, offeringId, {
    title: '观察表', body: '', url: '', status: 'DRAFT', file: new File(['原始字节'], '观察表.txt'),
  });
  const spare = await createResource(teacher, offeringId, { title: '备选材料', body: '草稿', url: '', status: 'DRAFT' });
  const assignment = await createAssignment(teacher, offeringId, {
    title: '观察作业', description: assignmentMaterialLink(offeringId, file), mode: 'INDIVIDUAL', status: 'DRAFT', dueAt: null,
  });
  const input = { title: '本周安排', revision: subpage.revision, document: doc(
    prose('请先观察'), ref('assignments', assignment.id), ref('resources', file.id), ref('resources', spare.id),
  ) };
  const plan = await previewCoursePublicationPlan(teacher, offeringId, subpage.id, input);
  assert.deepEqual(plan.records.map(record => [record.title, record.source, record.selectable]).sort(), [
    ['备选材料', 'page', true], ['观察作业', 'page', true], ['观察表', 'both', true],
  ].sort());
  assert.equal((await getCourseSubpage(student, offeringId, subpage.id)).page, null);
  assert.equal(await getCourseResourceFile(student, offeringId, file.id), null);
  const selected = plan.records.filter(record => record.id !== spare.id).map(record => record.key);
  const result = await applyCoursePublicationPlan(teacher, offeringId, subpage.id, input, plan.key, selected);
  assert.ok(result.page?.publishedAt);
  assert.ok((await getCourseSubpage(student, offeringId, subpage.id)).page?.publishedAt);
  const material = await getCourseResourceFile(student, offeringId, file.id);
  assert.ok(material && 'bytes' in material);
  assert.equal(Buffer.from(material.bytes).toString(), '原始字节');
  assert.equal((await getCourseResource(student, offeringId, spare.id)).resource, null);
  const published = await getAssignmentDetail(student, offeringId, assignment.id);
  assert.equal(published.assignment.description, assignment.description);
  const history = await db.assignmentRevision.findMany({ where: { assignmentId: assignment.id }, orderBy: { revision: 'asc' } });
  assert.deepEqual(history.map(entry => [entry.status, entry.description, entry.actorUserId]), [
    ['DRAFT', assignment.description, teacher], ['PUBLISHED', assignment.description, teacher],
  ]);
});

test('首页计划以记录修订复核，拒绝过期或越权选择并保护隐藏配套资料', async () => {
  const { offeringId, teacher, ta, student } = await fixture();
  const material = await createResource(teacher, offeringId, { title: '受保护的材料', body: '草稿', url: '', status: 'DRAFT' });
  const assignment = await createAssignment(teacher, offeringId, {
    title: '观察作业', description: assignmentMaterialLink(offeringId, material), mode: 'GROUP', status: 'DRAFT', dueAt: null,
  });
  const input = { title: '本周安排', revision: 0, document: doc(ref('assignments', assignment.id)) };
  const teacherPlan = await previewCoursePublicationPlan(teacher, offeringId, null, input);
  assert.equal(teacherPlan.records.find(record => record.id === assignment.id)?.deadline, null);
  assert.equal(teacherPlan.records.find(record => record.id === assignment.id)?.assignmentMode, 'GROUP');
  const taPlan = await previewCoursePublicationPlan(ta, offeringId, null, input);
  assert.equal(taPlan.hasProtectedReferences, true);
  assert.equal(taPlan.records.length, 1);
  assert.equal(taPlan.records[0].selectable, false);
  assert.ok(!JSON.stringify(taPlan).includes(material.id));
  await assert.rejects(applyCoursePublicationPlan(ta, offeringId, null, input, taPlan.key, [taPlan.records[0].key]), DomainError);
  await assert.rejects(previewCoursePublicationPlan(student, offeringId, null, input), DomainError);

  await updateResource(teacher, offeringId, material.id, { title: material.title, body: '改过的草稿', url: '', status: 'DRAFT' }, material.revision);
  await db.assignment.update({ where: { id: assignment.id }, data: { dueAt: new Date('2026-11-20T12:00:00Z'), revision: { increment: 1 } } });
  const stale = await applyCoursePublicationPlan(teacher, offeringId, null, input, teacherPlan.key, teacherPlan.records.map(record => record.key));
  assert.equal(stale.plan?.records.find(record => record.id === assignment.id)?.deadline, '2026-11-20T12:00:00.000Z');
  assert.notEqual(stale.plan?.key, teacherPlan.key);
  assert.equal(stale.page, undefined);
  assert.equal(await db.courseFocus.findUnique({ where: { offeringId } }), null);
  assert.equal((await db.assignment.findUniqueOrThrow({ where: { id: assignment.id } })).status, 'DRAFT');
  const changedPlan = stale.plan!;
  await assert.rejects(applyCoursePublicationPlan(teacher, offeringId, null, input, changedPlan.key, [changedPlan.records[0].key, 'forged']), DomainError);
  assert.equal(await db.courseFocus.findUnique({ where: { offeringId } }), null);
  const saved = await applyCoursePublicationPlan(teacher, offeringId, null, input, changedPlan.key, [changedPlan.records[0].key]);
  assert.ok(saved.page?.publishedAt);
  assert.equal(await getCourseResourceFile(student, offeringId, material.id), null);
});

test('资料发布在作业更新后失败时整批回滚，页面与要求历史保持原样', async () => {
  const { offeringId, teacher, student } = await fixture();
  const page = await createCourseSubpage(teacher, offeringId, '原草稿');
  const resource = await createResource(teacher, offeringId, {
    title: '回滚资料', body: '原文件说明', url: '', status: 'DRAFT',
  });
  const assignment = await createAssignment(teacher, offeringId, {
    title: '回滚作业', description: '原作业要求', mode: 'INDIVIDUAL', status: 'DRAFT', dueAt: null,
  });
  const input = {
    title: '原草稿', revision: page.revision,
    document: doc(ref('assignments', assignment.id), ref('resources', resource.id)),
  };
  const plan = await previewCoursePublicationPlan(teacher, offeringId, page.id, input);
  const functionName = 'test_reject_course_release_resource';
  const triggerName = 'test_reject_course_release_resource_update';
  const sqlLiteral = (value: string) => "'" + value.replaceAll("'", "''") + "'";

  // The injection targets this one fixture, and proves the earlier write was
  // visible inside the release transaction before forcing the rollback.
  await db.$executeRawUnsafe(`
    CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = ${sqlLiteral(resource.id)} AND NEW.status = 'PUBLISHED' THEN
        IF NOT EXISTS (
          SELECT 1 FROM "AssignmentRevision"
          WHERE "assignmentId" = ${sqlLiteral(assignment.id)}
            AND status = 'PUBLISHED' AND revision = ${assignment.revision + 1}
        ) THEN
          RAISE EXCEPTION 'release did not write the assignment revision first';
        END IF;
        RAISE EXCEPTION 'injected failure after assignment publication';
      END IF;
      RETURN NEW;
    END;
    $$`);
  try {
    await db.$executeRawUnsafe(`
      CREATE TRIGGER ${triggerName} BEFORE UPDATE ON "Resource"
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()
    `);
    await assert.rejects(
      applyCoursePublicationPlan(teacher, offeringId, page.id, input, plan.key, plan.records.map(record => record.key)),
      /injected failure after assignment publication/,
    );
    const savedAssignment = await db.assignment.findUniqueOrThrow({ where: { id: assignment.id } });
    const savedResource = await db.resource.findUniqueOrThrow({ where: { id: resource.id } });
    const revisions = await db.assignmentRevision.findMany({ where: { assignmentId: assignment.id } });
    const savedPage = await getCourseSubpage(teacher, offeringId, page.id);
    assert.equal(savedAssignment.status, 'DRAFT');
    assert.equal(savedAssignment.revision, assignment.revision);
    assert.deepEqual(revisions.map(record => [record.status, record.revision]), [['DRAFT', assignment.revision]]);
    assert.equal(savedResource.status, 'DRAFT');
    assert.equal(savedResource.revision, resource.revision);
    assert.equal(savedResource.firstPublishedAt, null);
    assert.equal(savedPage.page?.revision, page.revision);
    assert.equal(savedPage.page?.publishedAt, null);
    assert.equal((await getCourseSubpage(student, offeringId, page.id)).page, null);
  } finally {
    await db.$executeRawUnsafe(`DROP FUNCTION ${functionName}() CASCADE`);
  }
});
