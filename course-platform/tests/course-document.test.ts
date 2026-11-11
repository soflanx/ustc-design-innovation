import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { DomainError } from '../src/lib/management';
import { getCourseFocus, publishCourseDocument, saveCourseDocument, saveCourseDocumentDraft, saveCourseFocus } from '../src/lib/course-focus';
import { createCourseSubpage, saveCourseSubpage, withdrawCourseSubpage } from '../src/lib/course-subpages';
import { collectCourseReferences, courseTitleBlock, CourseDocumentError, ensureCoursePageTitle, legacyCourseDocument, normalizeCourseDocument, parseCourseDocument, retainCourseTitleReference, type CourseBlock, type CourseDocument } from '../src/lib/course-document';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(async () => { await db.$disconnect(); });
const paragraph = (text = '课程说明', children: CourseBlock[] = []): CourseBlock => ({ id: randomUUID(), type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children });
const view = (kind: 'assignments' | 'resources' | 'groups', ids: string[], title = '教学数据'): CourseBlock => ({ id: randomUUID(), type: 'courseData', props: { kind, ids: JSON.stringify(ids), layout: 'cards', title }, children: [] });
const record = (kind: 'assignments' | 'resources' | 'groups' | 'pages', recordId: string, display: 'link' | 'card' = 'link'): CourseBlock => ({ id: randomUUID(), type: 'courseRecord', props: { kind, recordId, display }, children: [] });
const doc = (...blocks: CourseBlock[]): CourseDocument => ({ version: 1, blocks });
const write = (title: string, document: CourseDocument, revision = 0) => ({ title, document, revision });

test('首页引用独立子页，发布时重读子页状态，撤回和重新发布即时改变学生入口', async () => {
  const { offering, teacher, ta, student } = await fixture();
  const page = await createCourseSubpage(teacher.id, offering.id, '第二次课阅读');
  const content = write('教学安排', doc(paragraph('课前读这页', [record('pages', page.id)]), record('pages', page.id, 'card')));
  const checked = (await publishCourseDocument(ta.id, offering.id, content)).review!;
  assert.deepEqual(checked.pages, { total: 1, draft: 1, published: 0, unknown: 0 });
  assert.equal(checked.hiddenCount, 1);
  assert.equal((await getCourseFocus(student.id, offering.id)).focus, null);
  const publishedPage = (await saveCourseSubpage(teacher.id, offering.id, page.id, write('第二次课阅读', doc(paragraph('读第二段')), page.revision), true)).page!;
  const updated = (await publishCourseDocument(ta.id, offering.id, content, checked.key)).review!;
  assert.notEqual(updated.key, checked.key);
  assert.deepEqual(updated.pages, { total: 1, draft: 0, published: 1, unknown: 0 });
  const publishedHome = (await publishCourseDocument(ta.id, offering.id, content, updated.key)).focus!;
  const studentHome = async () => (await getCourseFocus(student.id, offering.id)).focus!;
  assert.deepEqual(collectCourseReferences((await studentHome()).document).pageIds, [page.id]);
  const withdrawn = await withdrawCourseSubpage(teacher.id, offering.id, page.id, publishedPage.revision);
  const hidden = await studentHome();
  assert.ok(!JSON.stringify(hidden).includes(page.id));
  assert.ok(!JSON.stringify(hidden).includes('第二次课阅读'));

  const draft = await saveCourseDocumentDraft(ta.id, offering.id, { ...content, revision: publishedHome.revision });
  assert.deepEqual(collectCourseReferences(draft.draft!.document).pageIds, [page.id]);
  const next = { ...content, revision: draft.revision };
  const reviewed = (await publishCourseDocument(ta.id, offering.id, next)).review!;
  assert.equal(reviewed.pages.draft, 1);
  await publishCourseDocument(ta.id, offering.id, next, reviewed.key);
  assert.ok(!JSON.stringify(await studentHome()).includes(page.id));
  await saveCourseSubpage(ta.id, offering.id, page.id, write('新标题', withdrawn.draft!.document, withdrawn.revision), true);
  assert.deepEqual(collectCourseReferences((await studentHome()).document).pageIds, [page.id]);
});

test('子页引用要求目标属于本期，只能作为首页的单条记录保存', async () => {
  const f = await fixture(), other = await fixture();
  const page = await createCourseSubpage(f.teacher.id, f.offering.id, '同一期');
  const foreignPage = await createCourseSubpage(other.teacher.id, other.offering.id, '另一学期');
  for (const id of [foreignPage.id, randomUUID()]) {
    await assert.rejects(saveCourseDocumentDraft(f.teacher.id, f.offering.id, write('尝试引用', doc(record('pages', id)))), /本学期/);
  }
  const circular = write('引用自己', doc(paragraph('嵌套', [record('pages', page.id)])), page.revision);
  await assert.rejects(saveCourseSubpage(f.teacher.id, f.offering.id, page.id, circular, false), /只有课程首页/);
  assert.throws(() => parseCourseDocument(doc(record('pages', ''))), CourseDocumentError);
  const collection = view('resources', [page.id]);
  collection.props.kind = 'pages';
  assert.throws(() => parseCourseDocument(doc(collection)), CourseDocumentError);
});

test('标题块移动后保存位置与ID，学生和助教回读一致且数据库标题同步块内容', async () => {
  const f = await fixture();
  const document = ensureCoursePageTitle(doc(paragraph('先读说明')), '原型测试');
  const title = document.blocks[0];
  title.content = [{ type: 'text', text: '测试结果与下一步', styles: { bold: true } }];
  const moved = { ...document, blocks: [document.blocks[1], title] };
  const saved = await saveCourseDocument(f.teacher.id, f.offering.id, write('过时标题', moved));
  assert.equal(saved.title, '测试结果与下一步');
  assert.equal(saved.document.titleBlockId, title.id);
  assert.deepEqual(saved.document.blocks.map(block => block.id), moved.blocks.map(block => block.id));
  assert.equal((await db.courseFocus.findUniqueOrThrow({ where: { offeringId: f.offering.id } })).title, saved.title);
  for (const actor of [f.teacher, f.ta, f.student]) {
    const read = (await getCourseFocus(actor.id, f.offering.id)).focus!;
    assert.deepEqual(read.document, saved.document);
    assert.deepEqual(ensureCoursePageTitle(read.document, read.title), saved.document);
  }
  const nested = { ...saved.document, blocks: [{ ...saved.document.blocks[0], children: [title] }] };
  const resaved = await saveCourseDocument(f.ta.id, f.offering.id, write(saved.title, nested, saved.revision));
  assert.equal(courseTitleBlock(resaved.document)?.id, title.id);
  assert.equal(resaved.document.blocks[0].children?.[0].id, title.id);
});

test('标题删除状态持久化，旧标题迁移只在首次编辑保存时写入文档', async () => {
  const f = await fixture();
  const legacy = await saveCourseFocus(f.teacher.id, f.offering.id, { title: '旧页面', body: '旧正文', assignmentIds: [], resourceIds: [] });
  const editing = ensureCoursePageTitle(legacy.document, legacy.title);
  assert.equal((await db.courseFocus.findUniqueOrThrow({ where: { offeringId: f.offering.id } })).document, null);
  const upgraded = await saveCourseDocument(f.teacher.id, f.offering.id, write(legacy.title, editing, legacy.revision));
  const removed = retainCourseTitleReference(doc(...upgraded.document.blocks.filter(block => block.id !== upgraded.document.titleBlockId)), upgraded.document.titleBlockId!);
  await saveCourseDocument(f.teacher.id, f.offering.id, write(upgraded.title, removed, upgraded.revision));
  const read = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  assert.equal(read.document.titleBlockId, null);
  assert.equal(courseTitleBlock(read.document), undefined);
  assert.deepEqual(ensureCoursePageTitle(read.document, read.title), removed);
});

async function fixture() {
  const key = randomUUID();
  const [teacher, ta, student, outsider, admin] = await Promise.all(['teacher', 'ta', 'student', 'outsider', 'admin'].map(name => db.user.create({ data: { email: `${name}-${key}@test.invalid`, name, isAdmin: name === 'admin' } })));
  const course = await db.course.create({ data: { slug: key, title: '内容块测试' } });
  const term = await db.term.create({ data: { slug: key, name: '测试学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } });
  const offering = await db.courseOffering.create({ data: { courseId: course.id, termId: term.id, title: '测试开课', status: 'ACTIVE' } });
  const [teacherMember, taMember, studentMember] = await Promise.all([
    [teacher, 'TEACHER'], [ta, 'TA'], [student, 'STUDENT'],
  ].map(([user, role]) => db.courseMember.create({ data: { offeringId: offering.id, userId: (user as typeof teacher).id, role: role as 'TEACHER' | 'TA' | 'STUDENT' } })));
  const assignments = await Promise.all((['PUBLISHED', 'DRAFT', 'ARCHIVED'] as const).map(status => db.assignment.create({ data: { offeringId: offering.id, title: `${status}作业`, mode: 'INDIVIDUAL', status } })));
  const resources = await Promise.all((['PUBLISHED', 'DRAFT', 'ARCHIVED'] as const).map(status => db.resource.create({ data: { offeringId: offering.id, title: `${status}资料`, body: '说明', status } })));
  const groups = await Promise.all(['一组', '二组'].map(name => db.group.create({ data: { offeringId: offering.id, name } })));
  await db.groupMember.create({ data: { offeringId: offering.id, groupId: groups[0].id, courseMemberId: studentMember.id } });
  return { teacher, ta, student, outsider, admin, offering, teacherMember, taMember, studentMember, assignments, resources, groups };
}

test('内容块解析限定类型、格式、链接和规模，同时保留可移植的富文本', () => {
  const paragraphBlock = paragraph();
  paragraphBlock.content = [{ type: 'text', text: '重要', styles: { bold: true, textColor: 'blue' } }, { type: 'link', href: 'https://example.com/docs', content: [{ type: 'text', text: '阅读', styles: {} }] }];
  const parsed = parseCourseDocument(doc(paragraphBlock, { id: 'image-1', type: 'image', props: { url: '', showPreview: true }, children: [] }));
  assert.deepEqual(parsed.blocks[0].content, paragraphBlock.content);
  for (const href of ['javascript:alert(1)', 'data:text/html,x', '//example.com', '/\\example.com', 'https://user:pass@example.com', 'http:example.com']) {
    assert.throws(() => parseCourseDocument(doc({ ...paragraph(), content: [{ type: 'link', href, content: [] }] })), CourseDocumentError);
  }
  for (const invalid of [
    { version: 2, blocks: [] }, doc(paragraphBlock, paragraphBlock),
    doc({ ...paragraph(), type: 'iframe' } as unknown as CourseBlock),
    doc({ ...paragraph(), props: { style: 'position:fixed' } }),
    doc({ ...paragraph(), content: [{ type: 'text', text: 'x', styles: { textColor: '#ffffff' } }] }),
    doc({ id: 'h', type: 'heading', props: { level: '1' } }),
    doc(view('groups', ['x']), ...Array.from({ length: 250 }, () => paragraph())),
    doc({ ...view('groups', ['x']), content: [{ type: 'text', text: '不能在数据视图内保存行内文字', styles: {} }] }),
    doc(paragraph('x'.repeat(12001))),
    doc({ ...paragraph(), props: { textColor: ['blue'] } } as unknown as CourseBlock),
  ]) assert.throws(() => parseCourseDocument(invalid), CourseDocumentError);
  let nested = paragraph();
  for (let depth = 0; depth < 6; depth++) nested = paragraph('层级', [nested]);
  assert.throws(() => parseCourseDocument(doc(nested)), CourseDocumentError);
});

test('旧版教学说明及链接读取时转换，首次保存保留原数据并同步嵌套引用', async () => {
  const f = await fixture();
  const before = await saveCourseFocus(f.teacher.id, f.offering.id, { title: '原说明', body: '第一行\n第二行', assignmentIds: [f.assignments[0].id], resourceIds: [f.resources[0].id] });
  assert.deepEqual(before.document, legacyCourseDocument(before));
  assert.equal((await db.courseFocus.findUniqueOrThrow({ where: { offeringId: f.offering.id } })).document, null);
  const nextDocument = doc(paragraph('新说明', [view('assignments', [f.assignments[2].id, f.assignments[2].id])]), view('resources', [f.resources[0].id]));
  const saved = await saveCourseDocument(f.teacher.id, f.offering.id, write('自由编排', nextDocument, before.revision));
  assert.equal(saved.body, '');
  assert.equal((await db.courseFocus.findUniqueOrThrow({ where: { offeringId: f.offering.id } })).body, before.body);
  assert.equal(saved.revision, before.revision + 1);
  assert.deepEqual(saved.assignmentIds, [f.assignments[2].id]);
  assert.deepEqual(collectCourseReferences(saved.document), { assignmentIds: [f.assignments[2].id], resourceIds: [f.resources[0].id], groupIds: [], pageIds: [] });
  assert.deepEqual(await db.courseFocusAssignment.findMany({ where: { offeringId: f.offering.id }, select: { assignmentId: true } }), [{ assignmentId: f.assignments[2].id }]);
  await assert.rejects(saveCourseFocus(f.teacher.id, f.offering.id, { title: '旧表单覆盖', body: '', assignmentIds: [], resourceIds: [] }), /已升级/);
});

test('学生读取仅保留已发布或结束作业、已发布资料和自己的小组', async () => {
  const f = await fixture();
  await saveCourseDocument(f.teacher.id, f.offering.id, write('角色视图', doc(view('assignments', f.assignments.map(x => x.id)), view('resources', f.resources.map(x => x.id)), paragraph('分组', [view('groups', f.groups.map(x => x.id))]))));
  const student = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  const refs = collectCourseReferences(student.document);
  assert.deepEqual(new Set(refs.assignmentIds), new Set([f.assignments[0].id, f.assignments[2].id]));
  assert.deepEqual(refs.resourceIds, [f.resources[0].id]);
  assert.deepEqual(refs.groupIds, [f.groups[0].id]);
  assert.ok(!JSON.stringify(student.document).includes(f.resources[1].id));
  assert.ok(!JSON.stringify(student.document).includes(f.groups[1].id));
  await db.groupMember.updateMany({ where: { courseMemberId: f.studentMember.id }, data: { leftAt: new Date() } });
  assert.deepEqual(collectCourseReferences((await getCourseFocus(f.student.id, f.offering.id)).focus!.document).groupIds, []);
});

test('页面编辑独立鉴权，拒绝跨期引用、伪造隐藏资料与学生和失效成员写入', async () => {
  const f = await fixture();
  const other = await fixture();
  for (const actor of [f.student, f.outsider, other.teacher]) await assert.rejects(saveCourseDocument(actor.id, f.offering.id, write('越权', doc(paragraph()))), DomainError);
  for (const block of [view('assignments', [other.assignments[0].id]), view('resources', [other.resources[0].id]), view('groups', [other.groups[0].id])]) {
    await assert.rejects(saveCourseDocument(f.teacher.id, f.offering.id, write('错误引用', doc(paragraph('nested', [block])))), DomainError);
  }
  await assert.rejects(saveCourseDocument(f.ta.id, f.offering.id, write('不可读取', doc(view('resources', [f.resources[1].id])))), DomainError);
  assert.equal((await getCourseFocus(f.teacher.id, f.offering.id)).focus, null);
  await db.courseMember.update({ where: { id: f.taMember.id }, data: { status: 'INACTIVE' } });
  await assert.rejects(saveCourseDocument(f.ta.id, f.offering.id, write('失效成员', doc(paragraph()))), DomainError);
  await assert.rejects(getCourseFocus(f.outsider.id, f.offering.id), DomainError);
  await saveCourseDocument(f.admin.id, f.offering.id, write('管理员编辑', doc(paragraph())));
});

test('助教获得可编辑的公开视图和不泄漏标识的占位，保存及删除占位不会丢失隐藏引用', async () => {
  const f = await fixture();
  const mixed = view('resources', f.resources.map(x => x.id), '资料视图');
  await saveCourseDocument(f.teacher.id, f.offering.id, write('原版', doc(mixed)));
  const ta = (await getCourseFocus(f.ta.id, f.offering.id)).focus!;
  assert.deepEqual(collectCourseReferences(ta.document).resourceIds, [f.resources[0].id]);
  assert.equal(ta.document.blocks[1].type, 'protected');
  assert.deepEqual(ta.document.blocks[1].props, {});
  assert.ok(!JSON.stringify(ta).includes(f.resources[1].id));
  const saved = await saveCourseDocument(f.ta.id, f.offering.id, write('助教编辑', ta.document, ta.revision));
  const teacher = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  assert.equal(teacher.document.blocks.length, 1);
  assert.deepEqual(new Set(collectCourseReferences(teacher.document).resourceIds), new Set(f.resources.map(x => x.id)));
  // Drop both the editable projection and its opaque placeholder.
  await saveCourseDocument(f.ta.id, f.offering.id, write('只保留说明', doc(paragraph()), saved.revision));
  const retained = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  assert.deepEqual(new Set(collectCourseReferences(retained.document).resourceIds), new Set(f.resources.slice(1).map(x => x.id)));
  await assert.rejects(saveCourseDocument(f.ta.id, f.offering.id, write('伪造保留内容', doc({ id: '__locked_missing', type: 'protected', props: {} }), retained.revision)), DomainError);
  assert.equal((await getCourseFocus(f.teacher.id, f.offering.id)).focus!.revision, retained.revision);
});

test('可见范围变化不被旧页面绕过；教师可移除隐藏引用', async () => {
  const f = await fixture();
  await saveCourseDocument(f.teacher.id, f.offering.id, write('公开资料', doc(view('resources', [f.resources[0].id]))));
  const old = (await getCourseFocus(f.ta.id, f.offering.id)).focus!;
  await db.resource.update({ where: { id: f.resources[0].id }, data: { status: 'ARCHIVED' } });
  await assert.rejects(saveCourseDocument(f.ta.id, f.offering.id, write('旧页保存', old.document, old.revision)), DomainError);
  const current = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  const removed = await saveCourseDocument(f.teacher.id, f.offering.id, write('移除', doc(), current.revision));
  assert.deepEqual(removed.resourceIds, []);
});

test('数据视图、图片与保留占位下的正常嵌套内容能保存，隐藏引用仍独立过滤', async () => {
  const f = await fixture();
  const hiddenView = view('resources', [f.resources[1].id, f.resources[2].id], '隐藏资料标题');
  hiddenView.children = [paragraph('资料后的公开说明'), view('assignments', [f.assignments[0].id])];
  const image: CourseBlock = { id: randomUUID(), type: 'image', props: { url: 'https://example.com/photo.jpg' }, children: [hiddenView] };
  await saveCourseDocument(f.teacher.id, f.offering.id, write('嵌套内容', doc(image)));
  const ta = (await getCourseFocus(f.ta.id, f.offering.id)).focus!;
  assert.ok(!JSON.stringify(ta.document).includes('隐藏资料标题'));
  const children = ta.document.blocks[0].children!;
  const locked = children.find(block => block.type === 'protected')!;
  locked.children = [paragraph('在占位后新增的说明')];
  const saved = await saveCourseDocument(f.ta.id, f.offering.id, write('嵌套保存', ta.document, ta.revision));
  assert.ok(JSON.stringify(saved.document).includes('在占位后新增的说明'));
  const teacher = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  assert.deepEqual(new Set(collectCourseReferences(teacher.document).resourceIds), new Set([f.resources[1].id, f.resources[2].id]));
  assert.equal(JSON.stringify(teacher.document).split('资料后的公开说明').length - 1, 1);
  const beforeVisibilityChange = (await getCourseFocus(f.ta.id, f.offering.id)).focus!;
  await db.resource.update({ where: { id: f.resources[1].id }, data: { status: 'PUBLISHED' } });
  await assert.rejects(saveCourseDocument(f.ta.id, f.offering.id, write('旧的保留范围', beforeVisibilityChange.document, beforeVisibilityChange.revision)), /可见范围已改变/);
});

test('版本检查拒绝过期页面，并发首次创建及后续保存只有一份成功', async () => {
  const f = await fixture();
  for (const revision of [0, 1]) {
    const results = await Promise.allSettled(['甲', '乙'].map(title => saveCourseDocument(f.teacher.id, f.offering.id, write(title, doc(paragraph(title)), revision))));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.ok(failure.reason instanceof DomainError);
    const current = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
    assert.equal(current.revision, revision + 1);
    await assert.rejects(saveCourseDocument(f.ta.id, f.offering.id, write('过期编辑', doc(paragraph('不应写入')), revision)), /已更新|已创建/);
    assert.deepEqual((await getCourseFocus(f.teacher.id, f.offering.id)).focus, current);
  }
});

test('归档保留完整页面但阻止所有身份写入，非法内容失败不改写标题及引用', async () => {
  const f = await fixture();
  const saved = await saveCourseDocument(f.teacher.id, f.offering.id, write('原版', doc(view('assignments', [f.assignments[0].id]))));
  const invalid = { ...paragraph(), content: [{ type: 'link', href: 'javascript:alert(1)', content: [] }] } as CourseBlock;
  await assert.rejects(saveCourseDocument(f.teacher.id, f.offering.id, write('坏内容', doc(invalid), saved.revision)), DomainError);
  assert.deepEqual((await getCourseFocus(f.teacher.id, f.offering.id)).focus, saved);
  await db.courseOffering.update({ where: { id: f.offering.id }, data: { status: 'ARCHIVED' } });
  for (const actor of [f.teacher, f.ta, f.admin]) {
    assert.equal((await getCourseFocus(actor.id, f.offering.id)).canEdit, false);
    await assert.rejects(saveCourseDocument(actor.id, f.offering.id, write('归档修改', doc(paragraph()), saved.revision)), DomainError);
  }
  assert.deepEqual((await getCourseFocus(f.student.id, f.offering.id)).focus!.document, saved.document);
});

test('旧封装转为可独立编辑的标题和记录，保留顺序样式及子内容，ID稳定且不含记录标识', () => {
  const old = view('resources', ['resource-alpha', 'resource-beta'], '本次资料');
  old.id = 'materials';
  old.props = { ...old.props, layout: 'list', textColor: 'blue', textAlignment: 'center' };
  old.children = [paragraph('原有补充说明')];
  const collision = { ...paragraph('已有独立块'), id: 'materials-record-0' };
  const legacy = { ...paragraph('第一段\n第二段'), id: 'legacy-body' };
  const softBreak = paragraph('有意的\n软换行');
  const original = doc(legacy, old, collision, softBreak);
  const snapshot = structuredClone(original);
  const normalized = normalizeCourseDocument(original);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(normalizeCourseDocument(normalized), normalized);
  assert.deepEqual(normalizeCourseDocument(original), normalized);
  assert.deepEqual(normalized.blocks.slice(0, 2).map(block => block.content?.[0]), [
    { type: 'text', text: '第一段', styles: {} }, { type: 'text', text: '第二段', styles: {} },
  ]);
  const heading = normalized.blocks.find(block => block.id === old.id)!;
  assert.equal(heading.type, 'heading');
  assert.equal(heading.props.level, 2);
  assert.equal(heading.props.textColor, 'blue');
  const records = normalized.blocks.filter(block => block.type === 'courseRecord');
  assert.deepEqual(records.map(block => block.props.recordId), ['resource-alpha', 'resource-beta']);
  assert.ok(records.every(block => block.props.display === 'link' && block.props.textAlignment === 'center'));
  assert.ok(records.every(block => !block.id.includes('resource-alpha') && !block.id.includes('resource-beta')));
  assert.notEqual(records[0].id, collision.id);
  assert.equal(JSON.stringify(normalized).split('原有补充说明').length - 1, 1);
  assert.deepEqual(normalized.blocks.at(-1), softBreak);
  assert.doesNotThrow(() => parseCourseDocument(normalized));
});

test('明确的数据库视图原样保留；空旧视图保留选择入口；超限旧内容不截断也不阻止保存', () => {
  const grouped = view('assignments', ['a', 'b']);
  grouped.props.grouped = true;
  assert.deepEqual(normalizeCourseDocument(doc(grouped)), doc(grouped));
  const empty = normalizeCourseDocument(doc(view('resources', [], '待补资料')));
  assert.equal(empty.blocks[0].type, 'heading');
  assert.equal(empty.blocks[1].type, 'courseRecord');
  assert.equal(empty.blocks[1].props.recordId, '');
  assert.deepEqual(collectCourseReferences(empty).resourceIds, []);
  const crowded = doc(...Array.from({ length: 249 }, () => paragraph()), view('resources', ['a', 'b']));
  const preserved = normalizeCourseDocument(crowded);
  assert.equal(preserved.blocks.length, 250);
  assert.equal(preserved.blocks.at(-1)?.type, 'courseData');
  assert.equal(preserved.blocks.at(-1)?.props.grouped, true);
  assert.deepEqual(collectCourseReferences(preserved), collectCourseReferences(crowded));
  assert.doesNotThrow(() => parseCourseDocument(preserved));
  assert.deepEqual(normalizeCourseDocument(preserved), preserved);
  const manyLines = legacyCourseDocument({ body: Array.from({ length: 600 }, (_, index) => `段${index}`).join('\n'), assignmentIds: [], resourceIds: [] });
  assert.ok(manyLines.blocks.length <= 250);
  assert.equal(manyLines.blocks.map(block => (block.content?.[0] as { text: string }).text).join('\n'), Array.from({ length: 600 }, (_, index) => `段${index}`).join('\n'));
  assert.deepEqual(normalizeCourseDocument(manyLines), manyLines);
});

test('读取旧已保存文档只迁移普遍可见的视图，隐藏配置标题不会因迁移泄漏且不改写数据库', async () => {
  const f = await fixture();
  const publicView = view('resources', [f.resources[0].id], '本次资料');
  publicView.props.layout = 'list';
  const hiddenView = view('resources', [f.resources[1].id], '不能泄漏的旧配置标题');
  const groups = view('groups', f.groups.map(group => group.id), '小组视图');
  const oldDocument = doc({ ...paragraph('说明一\n说明二'), id: 'legacy-body' }, publicView, hiddenView, groups);
  await db.courseFocus.create({ data: { offeringId: f.offering.id, title: '旧已保存页面', body: '原始说明', document: oldDocument as object } });
  const teacher = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  assert.equal(teacher.document.blocks.find(block => block.id === publicView.id)?.type, 'heading');
  assert.equal(teacher.document.blocks.find(block => block.id === hiddenView.id)?.type, 'courseData');
  assert.equal(teacher.document.blocks.find(block => block.id === groups.id)?.props.grouped, true);
  const student = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  assert.ok(!JSON.stringify(student.document).includes('不能泄漏的旧配置标题'));
  assert.ok(!JSON.stringify(student.document).includes(f.resources[1].id));
  assert.ok(student.document.blocks.some(block => block.type === 'courseRecord' && block.props.recordId === f.resources[0].id));
  const persisted = await db.courseFocus.findUniqueOrThrow({ where: { offeringId: f.offering.id } });
  assert.deepEqual(persisted.document, oldDocument);
  assert.equal(persisted.revision, 0);
  const ta = (await getCourseFocus(f.ta.id, f.offering.id)).focus!;
  await saveCourseDocument(f.ta.id, f.offering.id, write('助教改说明', ta.document, ta.revision));
  const after = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  assert.deepEqual(new Set(after.resourceIds), new Set([f.resources[0].id, f.resources[1].id]));
  assert.ok(JSON.stringify(after.document).includes('不能泄漏的旧配置标题'));
  assert.ok(!JSON.stringify((await getCourseFocus(f.student.id, f.offering.id)).focus!.document).includes('不能泄漏的旧配置标题'));
});

test('独立记录支持空占位及独立排序删除，嵌套引用仍按课程和身份校验', async () => {
  const f = await fixture();
  const other = await fixture();
  const assignment = record('assignments', f.assignments[0].id, 'card');
  const resource = record('resources', f.resources[0].id);
  const saved = await saveCourseDocument(f.teacher.id, f.offering.id, write('独立块', doc(paragraph('自由说明'), assignment, paragraph('中间插入说明'), resource, record('groups', ''))));
  const moved = await saveCourseDocument(f.teacher.id, f.offering.id, write('移动记录', doc(resource, ...saved.document.blocks.filter(block => block.id !== resource.id && block.id !== assignment.id)), saved.revision));
  assert.equal(moved.document.blocks[0].id, resource.id);
  assert.deepEqual(moved.assignmentIds, []);
  assert.deepEqual(moved.resourceIds, [f.resources[0].id]);
  assert.ok(JSON.stringify(moved.document).includes('中间插入说明'));
  for (const invalid of [record('assignments', other.assignments[0].id), record('resources', other.resources[0].id), record('groups', other.groups[0].id)]) {
    await assert.rejects(saveCourseDocument(f.teacher.id, f.offering.id, write('跨期嵌套', doc(paragraph('nested', [invalid])), moved.revision)), DomainError);
  }
  await assert.rejects(saveCourseDocument(f.ta.id, f.offering.id, write('隐藏资料', doc(record('resources', f.resources[1].id)), moved.revision)), DomainError);
  const all = await saveCourseDocument(f.teacher.id, f.offering.id, write('独立可见性', doc(record('assignments', f.assignments[1].id), record('groups', f.groups[1].id), resource), moved.revision));
  const studentRefs = collectCourseReferences((await getCourseFocus(f.student.id, f.offering.id)).focus!.document);
  assert.deepEqual(studentRefs, { assignmentIds: [], resourceIds: [f.resources[0].id], groupIds: [], pageIds: [] });
  assert.equal(all.document.blocks.length, 3);
  assert.throws(() => parseCourseDocument(doc({ ...resource, props: { ...resource.props, display: 'grid' } })), CourseDocumentError);
});

test('助教编辑独立记录不会覆盖隐藏记录，删除或替换占位仍保留隐藏引用', async () => {
  const f = await fixture();
  const hidden = record('resources', f.resources[1].id);
  hidden.children = [paragraph('记录后的共享说明')];
  await saveCourseDocument(f.teacher.id, f.offering.id, write('独立隐藏记录', doc(hidden, record('resources', f.resources[0].id))));
  const ta = (await getCourseFocus(f.ta.id, f.offering.id)).focus!;
  assert.ok(!JSON.stringify(ta.document).includes(f.resources[1].id));
  assert.ok(JSON.stringify(ta.document).includes('记录后的共享说明'));
  const replacement = { ...record('resources', f.resources[0].id), id: hidden.id };
  const saved = await saveCourseDocument(f.ta.id, f.offering.id, write('替换可见记录', doc(replacement), ta.revision));
  assert.deepEqual(saved.resourceIds, [f.resources[0].id]);
  const teacher = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  assert.equal(teacher.document.blocks.length, 2);
  assert.deepEqual(new Set(teacher.resourceIds), new Set([f.resources[0].id, f.resources[1].id]));
  assert.notEqual(teacher.document.blocks[0].id, teacher.document.blocks[1].id);
  assert.equal(teacher.document.blocks[0].props.recordId, f.resources[0].id);
  assert.equal(teacher.document.blocks[1].props.recordId, f.resources[1].id);
});
