import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { DomainError } from '../src/lib/management';
import { getCourseFocus, publishCourseDocument, saveCourseDocument, saveCourseDocumentDraft, saveCourseFocus, withdrawCourseDocument } from '../src/lib/course-focus';
import { collectCourseReferences, createMarkdownBlock, ensureCoursePageTitle, expandCourseHomeLessonNotes, readMarkdownSource, type CourseBlock, type CourseDocument } from '../src/lib/course-document';
import { courseMarkdownReferenceLink } from '../src/lib/course-markdown-references';
import { applyCoursePublicationPlan, previewCoursePublicationPlan } from '../src/lib/course-publication-plan';
import { createCourseSubpage, saveCourseSubpage, withdrawCourseSubpage } from '../src/lib/course-subpages';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(async () => { await db.$disconnect(); });
const paragraph = (text: string): CourseBlock => ({ id: randomUUID(), type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] });
const record = (kind: 'assignments' | 'resources', recordId: string): CourseBlock => ({ id: randomUUID(), type: 'courseRecord', props: { kind, recordId, display: 'card' }, children: [] });
const doc = (...blocks: CourseBlock[]): CourseDocument => ({ version: 1, blocks });
const write = (title: string, document: CourseDocument, revision = 0) => ({ title, document, revision });

async function fixture() {
  const key = randomUUID();
  const [teacher, ta, student, outsider, admin] = await Promise.all(['teacher', 'ta', 'student', 'outsider', 'admin'].map(name => db.user.create({
    data: { email: `${name}-${key}@test.invalid`, name, isAdmin: name === 'admin' },
  })));
  const course = await db.course.create({ data: { slug: key, title: '页面草稿测试' } });
  const term = await db.term.create({ data: { slug: key, name: '测试学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } });
  const offering = await db.courseOffering.create({ data: { courseId: course.id, termId: term.id, title: '测试课程', status: 'ACTIVE' } });
  await Promise.all([[teacher.id, 'TEACHER'], [ta.id, 'TA'], [student.id, 'STUDENT']].map(([userId, role]) => db.courseMember.create({
    data: { offeringId: offering.id, userId, role: role as 'TEACHER' | 'TA' | 'STUDENT' },
  })));
  const assignment = await db.assignment.create({ data: { offeringId: offering.id, title: '公开作业', mode: 'INDIVIDUAL', status: 'PUBLISHED' } });
  const resource = await db.resource.create({ data: { offeringId: offering.id, title: '公开资料', body: '资料正文', status: 'PUBLISHED' } });
  const hidden = await db.resource.create({ data: { offeringId: offering.id, title: '隐藏资料', body: '教师私有草稿', status: 'DRAFT' } });
  return { teacher, ta, student, outsider, admin, offering, assignment, resource, hidden };
}

test('旧首页提示与正文可一同编辑，已发布内容与私有草稿分别展开', async () => {
  const f = await fixture();
  const lesson = await createCourseSubpage(f.teacher.id, f.offering.id, '观察练习');
  const publishedLesson = (await saveCourseSubpage(f.teacher.id, f.offering.id, lesson.id,
    write('观察练习', doc(paragraph('课次内容')), lesson.revision), true)).page!;
  const privateLesson = await createCourseSubpage(f.teacher.id, f.offering.id, '未发布的私有课次');
  const other = await fixture();
  const foreignLesson = await db.courseSubpage.create({ data: {
    id: randomUUID(), offeringId: other.offering.id, creationFingerprint: randomUUID(), title: '其他期开课',
    document: doc(), publishedAt: new Date(),
  } });
  const notes: CourseDocument = { ...doc(paragraph('学期说明')), lessonNotes: {
    previous: { text: '回看观察练习。', pageId: lesson.id }, next: { text: '这次无需准备。' },
  } };
  for (const invalidPage of [privateLesson, foreignLesson]) {
    await assert.rejects(saveCourseDocumentDraft(f.teacher.id, f.offering.id, write('课程说明', {
      ...notes, lessonNotes: { previous: { text: '', pageId: invalidPage.id } },
    })), /本学期.*课次|本学期.*课程子页面/);
  }
  await assert.rejects(saveCourseSubpage(f.teacher.id, f.offering.id, lesson.id,
    write('观察练习', { ...doc(), lessonNotes: { next: { text: '不得写入子页' } } }, publishedLesson.revision), false), /只在课程首页/);

  const privateDraft: CourseDocument = {
    ...doc(paragraph('仅教学团队可见的正文草稿')),
    lessonNotes: { previous: { text: '编辑草稿里的另一段回顾。', pageId: lesson.id } },
  };
  // Use the exact storage shape left by the previous split editor.
  await db.courseFocus.create({ data: {
    offeringId: f.offering.id, title: '课程说明', document: notes, publishedAt: new Date(),
    draftTitle: '新标题', draftDocument: privateDraft, draftSavedAt: new Date(), revision: 1,
  } });
  const studentHome = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  assert.deepEqual(studentHome.document, expandCourseHomeLessonNotes(notes));
  assert.equal(studentHome.draft, undefined);
  assert.ok(!JSON.stringify(studentHome).includes('另一段回顾'));
  const teacherHome = (await getCourseFocus(f.ta.id, f.offering.id)).focus!;
  assert.deepEqual(teacherHome.draft?.document, expandCourseHomeLessonNotes(privateDraft));
  const originalStorage = await db.courseFocus.findUniqueOrThrow({ where: { offeringId: f.offering.id } });
  assert.deepEqual(originalStorage.document, notes);
  assert.deepEqual(originalStorage.draftDocument, privateDraft);

  const projected = teacherHome.draft!.document;
  const changed = { ...projected, blocks: projected.blocks.map(block => block.type === 'markdown'
    ? createMarkdownBlock(block.id, '改成自由编写的正文。') : block) };
  const draft = await saveCourseDocumentDraft(f.ta.id, f.offering.id, write('新标题', changed, teacherHome.revision));
  assert.deepEqual((await getCourseFocus(f.student.id, f.offering.id)).focus?.document, studentHome.document);
  assert.deepEqual(draft.draft?.document, changed);

  const input = write('新标题', draft.draft!.document, draft.revision);
  const plan = await previewCoursePublicationPlan(f.ta.id, f.offering.id, null, input);
  assert.deepEqual(plan.records.map(record => [record.kind, record.id, record.status]), [['pages', lesson.id, 'PUBLISHED']]);
  const released = (await applyCoursePublicationPlan(f.ta.id, f.offering.id, null, input, plan.key, [])).page!;
  assert.deepEqual((await getCourseFocus(f.student.id, f.offering.id)).focus?.document, changed);

  await withdrawCourseSubpage(f.teacher.id, f.offering.id, lesson.id, publishedLesson.revision);
  const studentAfterWithdrawal = (await getCourseFocus(f.student.id, f.offering.id)).focus;
  assert.deepEqual(studentAfterWithdrawal?.document, { ...changed, blocks: changed.blocks.filter(block => block.type !== 'courseRecord') });
  assert.ok(!JSON.stringify(studentAfterWithdrawal).includes(lesson.id));
  const withdrawnHome = await withdrawCourseDocument(f.ta.id, f.offering.id, released.revision);
  assert.deepEqual(withdrawnHome.draft?.document, changed);
  const reopened = await saveCourseDocumentDraft(f.ta.id, f.offering.id,
    write('课程说明', withdrawnHome.draft!.document, withdrawnHome.revision));
  assert.deepEqual(reopened.draft?.document, changed);
  const studentAfterHomeWithdrawal = (await getCourseFocus(f.student.id, f.offering.id)).focus;
  assert.deepEqual(studentAfterHomeWithdrawal?.document, doc());
  assert.equal(studentAfterHomeWithdrawal?.draft, undefined);
});

test('首次保存页面草稿不会发布标题、正文或引用，学生响应没有草稿字段', async () => {
  const f = await fixture();
  const document = ensureCoursePageTitle(doc(paragraph('尚未完成的方案'), record('assignments', f.assignment.id), record('resources', f.resource.id)), '仅教师可见的页面标题');
  const saved = await saveCourseDocumentDraft(f.teacher.id, f.offering.id, write('旧标题', document));
  assert.equal(saved.revision, 1);
  assert.equal(saved.title, '');
  assert.deepEqual(saved.document, doc());
  assert.deepEqual(saved.assignmentIds, []);
  assert.deepEqual(saved.resourceIds, []);
  assert.equal(saved.publishedAt, null);
  assert.equal(saved.draft?.title, '仅教师可见的页面标题');
  assert.deepEqual(saved.draft?.document, document);
  assert.ok(saved.draft?.savedAt instanceof Date);
  for (const actor of [f.ta, f.admin]) assert.deepEqual((await getCourseFocus(actor.id, f.offering.id)).focus?.draft, saved.draft);
  const student = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  assert.equal('draft' in student, false);
  assert.equal(student.title, '');
  assert.deepEqual(student.document, doc());
  assert.deepEqual(student.assignmentIds, []);
  assert.deepEqual(student.resourceIds, []);
  assert.ok(!JSON.stringify(student).includes('尚未完成的方案'));
  assert.ok(!JSON.stringify(student).includes(f.assignment.id));
  assert.equal(await db.courseFocusAssignment.count({ where: { offeringId: f.offering.id } }), 0);
  assert.equal(await db.courseFocusResource.count({ where: { offeringId: f.offering.id } }), 0);
});

test('保存草稿保留已发布页面，显式发布使用传入最新编辑而非旧草稿并清理草稿', async () => {
  const f = await fixture();
  const published = await saveCourseDocument(f.teacher.id, f.offering.id, write('旧公开标题', doc(paragraph('旧公开正文'), record('assignments', f.assignment.id))));
  const draft = await saveCourseDocumentDraft(f.teacher.id, f.offering.id, write('草稿标题', doc(paragraph('草稿内容'), record('resources', f.resource.id)), published.revision));
  assert.deepEqual(draft.document, published.document);
  assert.equal(draft.title, published.title);
  assert.equal(draft.publishedAt?.getTime(), published.publishedAt?.getTime());
  assert.deepEqual(draft.assignmentIds, [f.assignment.id]);
  assert.deepEqual(draft.resourceIds, []);
  const beforePublish = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  assert.deepEqual(beforePublish.document, published.document);
  assert.equal('draft' in beforePublish, false);
  const finalDocument = doc(paragraph('发布前又修改的正文'), record('resources', f.resource.id));
  const final = await saveCourseDocument(f.ta.id, f.offering.id, write('最终标题', finalDocument, draft.revision));
  assert.equal(final.revision, draft.revision + 1);
  assert.equal(final.draft, undefined);
  assert.deepEqual(final.document, finalDocument);
  assert.equal(final.title, '最终标题');
  assert.ok(final.publishedAt instanceof Date);
  assert.deepEqual(final.assignmentIds, []);
  assert.deepEqual(final.resourceIds, [f.resource.id]);
  assert.deepEqual((await getCourseFocus(f.student.id, f.offering.id)).focus?.document, finalDocument);
  const stored = await db.courseFocus.findUniqueOrThrow({ where: { offeringId: f.offering.id } });
  assert.equal(stored.draftDocument, null);
  assert.equal(stored.draftTitle, null);
  assert.equal(stored.draftSavedAt, null);
  assert.equal(await db.courseFocusAssignment.count({ where: { offeringId: f.offering.id } }), 0);
  assert.equal(await db.courseFocusResource.count({ where: { offeringId: f.offering.id } }), 1);
});

test('草稿与发布共享版本保护，旧版本都不能覆盖；并发首次保存只成功一份', async () => {
  const f = await fixture();
  const results = await Promise.allSettled(['甲', '乙'].map(title => saveCourseDocumentDraft(f.teacher.id, f.offering.id, write(title, doc(paragraph(title))))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason instanceof DomainError);
  const current = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  for (const save of [saveCourseDocumentDraft, saveCourseDocument]) {
    await assert.rejects(save(f.ta.id, f.offering.id, write('过期草稿', doc(paragraph('不能覆盖')), 0)), /已更新|已创建/);
    assert.deepEqual((await getCourseFocus(f.teacher.id, f.offering.id)).focus, current);
  }
  const published = await saveCourseDocument(f.teacher.id, f.offering.id, write(current.draft!.title, current.draft!.document, current.revision));
  await assert.rejects(saveCourseDocumentDraft(f.ta.id, f.offering.id, write('发布前的旧草稿', doc(paragraph('旧')), current.revision)), /已更新/);
  assert.deepEqual((await getCourseFocus(f.teacher.id, f.offering.id)).focus, published);
});

test('草稿保持权限和跨期校验，归档后只能读取，非法内容不改变已有草稿', async () => {
  const f = await fixture(), other = await fixture();
  const original = await saveCourseDocumentDraft(f.teacher.id, f.offering.id, write('合法草稿', doc(paragraph('保留'))));
  for (const actor of [f.student, f.outsider, other.teacher]) await assert.rejects(saveCourseDocumentDraft(actor.id, f.offering.id, write('越权', doc(), original.revision)), DomainError);
  for (const invalid of [record('assignments', other.assignment.id), record('resources', other.resource.id)]) {
    await assert.rejects(saveCourseDocumentDraft(f.teacher.id, f.offering.id, write('跨期', doc(invalid), original.revision)), DomainError);
  }
  await assert.rejects(saveCourseDocumentDraft(f.ta.id, f.offering.id, write('伪造隐藏引用', doc(record('resources', f.hidden.id)), original.revision)), DomainError);
  const invalidLink = { ...paragraph('非法链接'), content: [{ type: 'link', href: 'javascript:alert(1)', content: [] }] } as CourseBlock;
  await assert.rejects(saveCourseDocumentDraft(f.teacher.id, f.offering.id, write('无效', doc(invalidLink), original.revision)), DomainError);
  assert.deepEqual((await getCourseFocus(f.teacher.id, f.offering.id)).focus, original);
  await db.courseOffering.update({ where: { id: f.offering.id }, data: { status: 'ARCHIVED' } });
  for (const actor of [f.teacher, f.ta, f.admin]) {
    const read = await getCourseFocus(actor.id, f.offering.id);
    assert.equal(read.canEdit, false);
    assert.ok(read.focus?.draft);
    for (const save of [saveCourseDocumentDraft, saveCourseDocument]) await assert.rejects(save(actor.id, f.offering.id, write('归档后', doc(), original.revision)), DomainError);
  }
  assert.equal('draft' in (await getCourseFocus(f.student.id, f.offering.id)).focus!, false);
});

test('助教保存和发布以最新草稿恢复隐藏引用，不泄漏也不因删除占位丢失', async () => {
  const f = await fixture();
  const published = await saveCourseDocument(f.teacher.id, f.offering.id, write('公开版本', doc(paragraph('公开说明'), record('resources', f.resource.id))));
  await saveCourseDocumentDraft(f.teacher.id, f.offering.id, write('教师草稿', doc(paragraph('草稿说明'), record('resources', f.hidden.id)), published.revision));
  const ta = (await getCourseFocus(f.ta.id, f.offering.id)).focus!;
  assert.ok(ta.draft!.document.blocks.some(block => block.type === 'protected'));
  assert.ok(!JSON.stringify(ta.draft).includes(f.hidden.id));
  const edited = doc(...ta.draft!.document.blocks.filter(block => block.type !== 'protected'), paragraph('助教补充'));
  const saved = await saveCourseDocumentDraft(f.ta.id, f.offering.id, write('助教草稿', edited, ta.revision));
  assert.deepEqual(saved.document, ta.document);
  // The live editor intentionally keeps its local document and undo history
  // after Save Draft. Reusing it must preserve server-restored hidden records.
  const continuingLocalDocument = doc(...edited.blocks, paragraph('保存后继续编辑'));
  const resaved = await saveCourseDocumentDraft(f.ta.id, f.offering.id, write('继续编辑的草稿', continuingLocalDocument, saved.revision));
  const teacher = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  assert.deepEqual(collectCourseReferences(teacher.draft!.document).resourceIds, [f.hidden.id]);
  assert.ok(JSON.stringify(teacher.draft).includes('助教补充'));
  assert.ok(JSON.stringify(teacher.draft).includes('保存后继续编辑'));
  const released = await saveCourseDocument(f.ta.id, f.offering.id, write(resaved.draft!.title, continuingLocalDocument, resaved.revision));
  assert.equal(released.draft, undefined);
  assert.deepEqual((await getCourseFocus(f.teacher.id, f.offering.id)).focus?.resourceIds, [f.hidden.id]);
  assert.deepEqual((await getCourseFocus(f.student.id, f.offering.id)).focus?.resourceIds, []);
  assert.ok(!JSON.stringify((await getCourseFocus(f.student.id, f.offering.id)).focus).includes(f.hidden.id));
});

test('草稿中的隐藏范围改变会拒绝过期占位，保留先前草稿和公开版本', async () => {
  const f = await fixture();
  await saveCourseDocumentDraft(f.teacher.id, f.offering.id, write('隐藏草稿', doc(record('resources', f.hidden.id))));
  const ta = (await getCourseFocus(f.ta.id, f.offering.id)).focus!;
  await db.resource.update({ where: { id: f.hidden.id }, data: { status: 'PUBLISHED' } });
  const current = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  for (const save of [saveCourseDocumentDraft, saveCourseDocument]) {
    await assert.rejects(save(f.ta.id, f.offering.id, write('旧保留范围', ta.draft!.document, ta.revision)), /可见范围已改变/);
    assert.deepEqual((await getCourseFocus(f.teacher.id, f.offering.id)).focus, current);
  }
});

test('Markdown 课程引用遵守同期开课范围、子页边界和草稿读取权限', async () => {
  const f = await fixture(), other = await fixture();
  const lesson = await createCourseSubpage(f.teacher.id, f.offering.id, '本期未发布课次');
  const foreignLesson = await createCourseSubpage(other.teacher.id, other.offering.id, '跨期开课的课次');
  const foreignGroup = await db.group.create({ data: { offeringId: other.offering.id, name: '跨期组' } });
  const body = (source: string) => doc(createMarkdownBlock('body', source));
  for (const [kind, id] of [['assignments', other.assignment.id], ['resources', other.resource.id], ['groups', foreignGroup.id], ['pages', foreignLesson.id]] as const) {
    await assert.rejects(saveCourseDocumentDraft(f.teacher.id, f.offering.id, write('跨期尝试',
      body(`> 练习 **${courseMarkdownReferenceLink(kind, id, '跨期对象')}**`))), /本学期可读取/);
  }
  const typedPage = courseMarkdownReferenceLink('pages', lesson.id, '本期未发布课次');
  await assert.rejects(saveCourseSubpage(f.teacher.id, f.offering.id, lesson.id,
    write('子页尝试', body(typedPage), lesson.revision), false), /只有课程首页/);
  await assert.rejects(saveCourseDocumentDraft(f.ta.id, f.offering.id, write('隐藏引用尝试',
    body(courseMarkdownReferenceLink('resources', f.hidden.id, '猜测标题')))), /本学期可读取的有效资料/);
  await assert.rejects(saveCourseDocumentDraft(f.teacher.id, f.offering.id, write('无效引用尝试',
    body(`[练习](course:assignments/${f.assignment.id}#submission)`))), /课程引用格式不正确/);

  const codeExample = '`[不是引用](course:pages/' + foreignLesson.id + ')`';
  const draft = await saveCourseDocumentDraft(f.teacher.id, f.offering.id, write('仅草稿的标题', body(`${codeExample}\n\n${typedPage}`)));
  assert.deepEqual(collectCourseReferences(draft.draft!.document).pageIds, [lesson.id]);
  const plan = await previewCoursePublicationPlan(f.teacher.id, f.offering.id, null,
    write('仅草稿的标题', draft.draft!.document, draft.revision));
  assert.deepEqual(plan.records.map(({ kind, id, status }) => [kind, id, status]), [['pages', lesson.id, 'DRAFT']]);
  const student = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  assert.equal(student.draft, undefined);
  assert.ok(!JSON.stringify(student).includes(lesson.id));
});

test('助教编辑 Markdown 邻文后可用同一编辑状态发布，隐藏引用不会暴露或丢失', async () => {
  const f = await fixture();
  const work = courseMarkdownReferenceLink('assignments', f.assignment.id, '本周练习');
  const resource = courseMarkdownReferenceLink('resources', f.resource.id, '阅读材料');
  const secretLabel = '准备中的阅读片段';
  const hidden = courseMarkdownReferenceLink('resources', f.hidden.id, secretLabel);
  const protectedParagraph = `另有 ${hidden} 等待确认，发布后再讨论。`;
  const original = `这周完成 ${work}。请读 ${resource}。\n\n${protectedParagraph}\n\n回顾观察过程。`;
  await saveCourseDocumentDraft(f.teacher.id, f.offering.id, write('课程说明', doc(createMarkdownBlock('body', original))));
  const ta = (await getCourseFocus(f.ta.id, f.offering.id)).focus!;
  const opaque = ta.draft!.document.blocks.find(block => block.type === 'protected')!;
  assert.ok(opaque);
  const visible = ta.draft!.document.blocks.filter(block => block.type === 'markdown');
  assert.equal(visible.length, 2);
  assert.match(readMarkdownSource(visible[0]), /这周完成/);
  assert.match(readMarkdownSource(visible[1]), /回顾观察过程/);
  assert.ok(!JSON.stringify(ta).includes(f.hidden.id));
  assert.ok(!JSON.stringify(ta).includes(secretLabel));

  const untouched = await saveCourseDocumentDraft(f.ta.id, f.offering.id,
    write('课程说明', doc(...ta.draft!.document.blocks, paragraph('加一段说明。')), ta.revision));
  const preserved = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!.draft!.document;
  assert.equal(readMarkdownSource(preserved.blocks.find(block => block.id === 'body')!), protectedParagraph);

  // Continuous editor saves can assign new IDs to both editable text slices.
  const local = doc(createMarkdownBlock('new-before', readMarkdownSource(visible[0])), opaque,
    createMarkdownBlock('new-after', '助教补充：先讨论观察记录。'));
  const saved = await saveCourseDocumentDraft(f.ta.id, f.offering.id, write('课程说明', local, untouched.revision));
  assert.ok(saved.draft?.document.blocks.some(block => block.id === opaque.id));
  // The editor keeps its own document and undo stack after saving a draft.
  const input = write('课程说明', local, saved.revision);
  const plan = await previewCoursePublicationPlan(f.ta.id, f.offering.id, null, input);
  assert.equal(plan.hasProtectedReferences, true);
  assert.ok(!JSON.stringify(plan).includes(f.hidden.id));
  assert.ok(!JSON.stringify(plan).includes(secretLabel));
  assert.deepEqual(plan.records.map(({ id }) => id).sort(), [f.assignment.id, f.resource.id].sort());
  const released = await applyCoursePublicationPlan(f.ta.id, f.offering.id, null, input, plan.key, []);
  assert.ok(released.page?.publishedAt);

  const student = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  assert.ok(JSON.stringify(student).includes('先讨论观察记录'));
  assert.ok(!JSON.stringify(student).includes(secretLabel));
  assert.ok(!JSON.stringify(student).includes(f.hidden.id));
  assert.deepEqual(collectCourseReferences(student.document).resourceIds, [f.resource.id]);
  const teacher = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  assert.deepEqual(teacher.document.blocks.map(readMarkdownSource), [readMarkdownSource(visible[0]), protectedParagraph, '助教补充：先讨论观察记录。']);
  assert.deepEqual(collectCourseReferences(teacher.document).resourceIds.sort(), [f.resource.id, f.hidden.id].sort());

  await db.resource.update({ where: { id: f.resource.id }, data: { status: 'ARCHIVED' } });
  const afterWithdrawal = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  assert.ok(!JSON.stringify(afterWithdrawal).includes(f.resource.id));
  assert.ok(!JSON.stringify(afterWithdrawal).includes('阅读材料'));
  assert.ok(JSON.stringify(afterWithdrawal).includes('先讨论观察记录'));
});

test('旧版已发布正文兼容读取，保存草稿不升级公开内容，发布时才替换', async () => {
  const f = await fixture();
  const legacy = await saveCourseFocus(f.teacher.id, f.offering.id, { title: '旧版标题', body: '旧版正文', assignmentIds: [f.assignment.id], resourceIds: [f.resource.id] });
  const draft = await saveCourseDocumentDraft(f.ta.id, f.offering.id, write('新版草稿', doc(paragraph('新版正文')), legacy.revision));
  assert.deepEqual(draft.document, legacy.document);
  const beforePublish = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  assert.deepEqual(beforePublish.document, legacy.document);
  assert.equal(beforePublish.body, '旧版正文');
  const row = await db.courseFocus.findUniqueOrThrow({ where: { offeringId: f.offering.id } });
  assert.equal(row.document, null);
  assert.equal(row.body, legacy.body);
  assert.equal(row.title, legacy.title);
  await assert.rejects(saveCourseFocus(f.teacher.id, f.offering.id, { title: '旧表单', body: '', assignmentIds: [], resourceIds: [] }), /已升级/);
  const published = await saveCourseDocument(f.ta.id, f.offering.id, write(draft.draft!.title, draft.draft!.document, draft.revision));
  assert.deepEqual(published.document, draft.draft!.document);
  assert.deepEqual(published.assignmentIds, []);
  assert.deepEqual(published.resourceIds, []);
  for (const actor of [f.student, f.ta, f.teacher]) {
    const read = (await getCourseFocus(actor.id, f.offering.id)).focus!;
    assert.equal(read.body, '');
    assert.ok(!JSON.stringify(read).includes('旧版正文'));
  }
  assert.equal((await db.courseFocus.findUniqueOrThrow({ where: { offeringId: f.offering.id } })).body, '旧版正文');
});

test('已取消作业仍可在发布页回看，草稿引用不提前进入学生响应', async () => {
  const f = await fixture();
  await db.assignment.update({ where: { id: f.assignment.id }, data: { status: 'CANCELLED', cancellationReason: '教学安排调整' } });
  const draft = await saveCourseDocumentDraft(f.teacher.id, f.offering.id, write('已取消任务说明', doc(record('assignments', f.assignment.id))));
  assert.deepEqual((await getCourseFocus(f.student.id, f.offering.id)).focus?.assignmentIds, []);
  await saveCourseDocument(f.teacher.id, f.offering.id, write(draft.draft!.title, draft.draft!.document, draft.revision));
  const student = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  assert.deepEqual(student.assignmentIds, [f.assignment.id]);
  assert.deepEqual(collectCourseReferences(student.document).assignmentIds, [f.assignment.id]);
});

test('首页在发布事务内重新核对引用，旧确认不会提交，成功回执使用实际状态', async () => {
  const f = await fixture();
  const input = write('活动', doc(record('resources', f.hidden.id), record('resources', f.resource.id)));
  const initial = await publishCourseDocument(f.teacher.id, f.offering.id, input);
  assert.equal(initial.review?.hiddenCount, 1);
  assert.equal(await db.courseFocus.count({ where: { offeringId: f.offering.id } }), 0);
  await db.resource.update({ where: { id: f.resource.id }, data: { status: 'ARCHIVED' } });
  const changed = await publishCourseDocument(f.teacher.id, f.offering.id, input, initial.review!.key);
  assert.equal(changed.review?.hiddenCount, 2);
  await db.resource.updateMany({ where: { id: { in: [f.hidden.id, f.resource.id] } }, data: { status: 'PUBLISHED' } });
  const cleared = await publishCourseDocument(f.teacher.id, f.offering.id, input, changed.review!.key);
  assert.equal(cleared.review?.hiddenCount, 0);
  assert.equal(await db.courseFocus.count({ where: { offeringId: f.offering.id } }), 0);
  const published = await publishCourseDocument(f.teacher.id, f.offering.id, input, cleared.review!.key);
  assert.equal(published.summary?.resources.published, 2);
  assert.equal(published.focus?.revision, 1);
});

test('助教撤回旧首页时保留原始私有引用，学生不再收到正文与首页引用，重发仍受保护', async () => {
  const f = await fixture();
  const original = await saveCourseFocus(f.teacher.id, f.offering.id, { title: '旧首页', body: '旧公开段落', assignmentIds: [f.assignment.id], resourceIds: [f.resource.id, f.hidden.id] });
  await assert.rejects(withdrawCourseDocument(f.student.id, f.offering.id, original.revision), DomainError);
  await assert.rejects(withdrawCourseDocument(f.ta.id, f.offering.id, original.revision - 1), /已更新/);
  const withdrawn = await withdrawCourseDocument(f.ta.id, f.offering.id, original.revision);
  assert.equal(withdrawn.publishedAt, null);
  assert.ok(withdrawn.draft?.document.blocks.some(block => block.type === 'protected'));
  assert.ok(!JSON.stringify(withdrawn).includes(f.hidden.id));
  const teacherDraft = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!.draft!;
  assert.ok(collectCourseReferences(teacherDraft.document).resourceIds.includes(f.hidden.id));
  const student = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  assert.equal(student.title, '');
  assert.equal(student.body, '');
  assert.deepEqual(student.document.blocks, []);
  assert.deepEqual(student.assignmentIds, []);
  assert.deepEqual(student.resourceIds, []);
  assert.equal(student.draft, undefined);
  assert.equal(await db.courseFocusAssignment.count({ where: { offeringId: f.offering.id } }), 0);
  assert.equal(await db.courseFocusResource.count({ where: { offeringId: f.offering.id } }), 0);
  const input = write(withdrawn.draft!.title, withdrawn.draft!.document, withdrawn.revision);
  const check = await publishCourseDocument(f.ta.id, f.offering.id, input);
  assert.equal(check.review?.hasProtectedReferences, true);
  assert.ok(!JSON.stringify(check).includes(f.hidden.id));
  const published = await publishCourseDocument(f.ta.id, f.offering.id, input, check.review!.key);
  assert.ok(published.focus?.publishedAt);
  assert.ok(!JSON.stringify(published).includes(f.hidden.id));
  const raw = (await getCourseFocus(f.teacher.id, f.offering.id)).focus!;
  assert.ok(raw.resourceIds.includes(f.hidden.id));
  const readable = (await getCourseFocus(f.student.id, f.offering.id)).focus!;
  assert.ok(JSON.stringify(readable).includes('旧公开段落'));
  assert.ok(!JSON.stringify(readable).includes(f.hidden.id));
});

test('首页撤回保留已更新草稿并增加版本，保存旧版本和归档后的撤回不可写入', async () => {
  const f = await fixture();
  const original = await saveCourseDocument(f.teacher.id, f.offering.id, write('第一版', doc(paragraph('已发布方案'))));
  const draft = await saveCourseDocumentDraft(f.ta.id, f.offering.id, write('第二版', doc(paragraph('新准备的段落')), original.revision));
  await assert.rejects(withdrawCourseDocument(f.teacher.id, f.offering.id, original.revision), /已更新/);
  const withdrawn = await withdrawCourseDocument(f.teacher.id, f.offering.id, draft.revision);
  assert.deepEqual(withdrawn.draft, draft.draft);
  await assert.rejects(saveCourseDocumentDraft(f.ta.id, f.offering.id, write('旧编辑', doc(), draft.revision)), /已更新/);
  const republished = (await publishCourseDocument(f.teacher.id, f.offering.id, write(withdrawn.draft!.title, withdrawn.draft!.document, withdrawn.revision))).focus!;
  await db.courseOffering.update({ where: { id: f.offering.id }, data: { status: 'ARCHIVED' } });
  await assert.rejects(withdrawCourseDocument(f.teacher.id, f.offering.id, republished.revision), /归档/);
  assert.equal((await getCourseFocus(f.student.id, f.offering.id)).focus!.title, '第二版');
});
