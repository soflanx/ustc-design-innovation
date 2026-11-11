import { test } from 'node:test';
import assert from 'node:assert/strict';
import { courseStudentPreview } from '../src/lib/course-student-preview';
import { createMarkdownBlock, parseCourseDocument, type CourseBlock, type CourseDocument } from '../src/lib/course-document';
import { courseSubpageReference, type CourseDocumentCatalog, type CourseDocumentRecord } from '../src/lib/course-document-view';

const paragraph = (id: string, text: string): CourseBlock => ({ id, type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] });
const reference = (id: string, kind: 'assignments' | 'resources' | 'groups' | 'pages', recordId: string, children: CourseBlock[] = []): CourseBlock => ({ id, type: 'courseRecord', props: { kind, recordId, display: 'card' }, children });
const group = (id: string, kind: 'assignments' | 'resources' | 'groups', ids: string[], title = '合集'): CourseBlock => ({ id, type: 'courseData', props: { kind, ids: JSON.stringify(ids), title, layout: 'cards' }, children: [] });
const assignment = (id: string, visibilityStatus: CourseDocumentRecord['visibilityStatus']): CourseDocumentRecord => ({
  id, title: `作业 ${id}`, href: `/courses/course/assignments/${id}?view=pending&scope=all`, visibilityStatus,
  status: '全班已交 2/9 人 · 待反馈 2', scope: 'all', secondaryHref: '/staff-only', secondaryLabel: '查看全班',
  progressHint: '全班待评阅 2 份', deadline: '2026-11-15T15:59:00.000Z',
  subtitle: '个人提交', lifecycleLabel: visibilityStatus === 'DRAFT' ? '学生不可见' : '已发布 · 接受提交', detail: visibilityStatus === 'CANCELLED' ? '取消原因：课程安排调整' : '仅教师使用的处理信息',
  assignment: { title: id, description: '内部表单数据', mode: 'INDIVIDUAL', status: visibilityStatus ?? 'DRAFT', dueAt: '', versionCount: 2, revision: 3, cancellationReason: null, maxScore: 100 },
});
const resource = (id: string, visibilityStatus: CourseDocumentRecord['visibilityStatus']): CourseDocumentRecord => ({
  id, title: `资料 ${id}`, href: `/courses/course/resources/${id}`, visibilityStatus,
  resource: { title: id, body: '仅表单使用的正文', url: '', status: visibilityStatus === 'CANCELLED' ? 'DRAFT' : visibilityStatus ?? 'DRAFT', revision: 2 },
});
const catalog = (): CourseDocumentCatalog => ({
  assignments: [assignment('draft', 'DRAFT'), assignment('open', 'PUBLISHED'), assignment('ended', 'ARCHIVED'), assignment('cancelled', 'CANCELLED'), assignment('unknown', undefined)],
  resources: [resource('r-draft', 'DRAFT'), resource('r-open', 'PUBLISHED'), resource('r-withdrawn', 'ARCHIVED'), resource('r-unknown', undefined)],
  groups: [{ id: 'other-group', title: '另一个小组的私有标题', href: '/courses/course/groups/other-group', detail: '组员信息' }],
});

test('学生预览按记录状态过滤，且剥离教师统计、管理动作与编辑表单', () => {
  const source = catalog();
  const document: CourseDocument = { version: 1, blocks: [
    ...source.assignments.map(record => reference(`a-${record.id}`, 'assignments', record.id)),
    ...source.resources.map(record => reference(`r-${record.id}`, 'resources', record.id)),
  ] };
  const projected = courseStudentPreview(document, source);
  assert.deepEqual(projected.catalog.assignments.map(record => record.id), ['open', 'ended', 'cancelled']);
  assert.deepEqual(projected.catalog.resources.map(record => record.id), ['r-open']);
  assert.ok(projected.catalog.assignments.every(record => record.deadline === '2026-11-15T15:59:00.000Z'));
  assert.deepEqual(projected.document.blocks.map(block => block.id), ['a-open', 'a-ended', 'a-cancelled', 'r-r-open']);
  for (const record of [...projected.catalog.assignments, ...projected.catalog.resources]) {
    assert.equal(record.assignment, undefined); assert.equal(record.resource, undefined);
    assert.equal(record.progressHint, undefined);
    assert.equal(record.scope, undefined); assert.equal(record.secondaryHref, undefined); assert.equal(record.secondaryLabel, undefined);
    assert.ok(!record.href.includes('scope=')); assert.ok(!record.href.includes('view=pending'));
    assert.ok(!JSON.stringify(record).includes('全班已交')); assert.ok(!JSON.stringify(record).includes('内部表单数据'));
    assert.ok(!JSON.stringify(record).includes('仅教师使用'));
  }
});

test('隐藏引用与保留占位不带出标识或标题，公开子内容与同层说明保持顺序', () => {
  const source = catalog();
  const document: CourseDocument = { version: 1, titleBlockId: 'heading', blocks: [
    { id: 'heading', type: 'heading', props: { level: 1 }, content: [{ type: 'text', text: '课程', styles: {} }], children: [] },
    reference('hidden-slot', 'assignments', 'draft', [paragraph('child', '普通共享说明'), reference('public-child', 'resources', 'r-open')]),
    { id: '__locked_private', type: 'protected', props: {}, children: [paragraph('after-lock', '另一个共享段落')] },
    group('mixed', 'resources', ['r-draft', 'r-open', 'r-withdrawn']),
    group('hidden-all', 'assignments', ['draft', 'unknown'], '不应出现的私有合集标题'),
  ] };
  const result = courseStudentPreview(document, source);
  assert.equal(result.document.titleBlockId, 'heading');
  assert.deepEqual(result.document.blocks.map(block => block.id), ['heading', 'child', 'public-child', 'after-lock', 'mixed']);
  assert.equal(result.document.blocks.at(-1)?.props.ids, '["r-open"]');
  const serialized = JSON.stringify(result);
  for (const secret of ['hidden-slot', '__locked_private', '不应出现的私有合集标题', 'r-draft', 'r-withdrawn', 'r-unknown']) assert.ok(!serialized.includes(secret));
});

test('小组预览只给身份占位，不选择任意学生或暴露其它组标题和成员', () => {
  const document: CourseDocument = { version: 1, blocks: [
    reference('single-group', 'groups', 'other-group', [paragraph('shared-child', '小组入口后的通用说明')]),
    group('group-list', 'groups', ['other-group'], '不应展示的组合集标题'),
  ] };
  const result = courseStudentPreview(document, catalog());
  assert.deepEqual(result.catalog.groups, []);
  assert.ok(result.document.blocks.every(block => block.type === 'paragraph'));
  assert.equal(result.document.blocks[0].children?.[0].id, 'shared-child');
  const serialized = JSON.stringify(result);
  for (const secret of ['other-group', '另一个小组的私有标题', '组员信息', '不应展示的组合集标题']) assert.ok(!serialized.includes(secret));
  assert.ok(serialized.includes('仅所选小组的成员能看到自己组的入口'));
});

test('首页预览只展示已发布子页的公开标题，撤回引用不带出标题或网址', () => {
  const published = courseSubpageReference('course', {
    id: 'workshop', title: '未发布的新名字', publishedTitle: '工作坊指南', publishedAt: new Date(), hasDraft: true,
  });
  const hidden = courseSubpageReference('course', {
    id: 'private-page', title: '内部备课', publishedTitle: null, publishedAt: null, hasDraft: true,
  });
  assert.equal(published.status, '有未发布修改');
  assert.equal(hidden.status, '草稿');
  const document: CourseDocument = { version: 1, blocks: [
    reference('live', 'pages', published.id), reference('withdrawn', 'pages', hidden.id, [paragraph('child', '后续说明')]),
  ], lessonNotes: { previous: { text: '回看工作坊的观察练习。', pageId: published.id }, next: { text: '', pageId: hidden.id } } };
  const result = courseStudentPreview(document, { ...catalog(), pages: [published, hidden] });
  assert.deepEqual(result.catalog.pages, [{ id: 'workshop', title: '工作坊指南', href: '/courses/course/pages/workshop' }]);
  assert.deepEqual(result.document.blocks.map(block => block.id), ['legacy-home-previous-text', 'legacy-home-previous-page', 'live', 'child']);
  assert.equal(result.document.lessonNotes, undefined);
  assert.match(JSON.stringify(result.document), /回看工作坊的观察练习/);
  assert.doesNotMatch(JSON.stringify(result), /未发布的新名字|内部备课|private-page|有未发布修改/);
  const withoutPages = courseStudentPreview(document, catalog());
  assert.equal(withoutPages.catalog.pages, undefined);
  assert.deepEqual(withoutPages.document.blocks.map(block => block.id), ['legacy-home-previous-text', 'child']);
  assert.match(JSON.stringify(withoutPages.document), /回看工作坊的观察练习/);
  assert.equal(document.lessonNotes?.next?.pageId, hidden.id);
  assert.equal(parseCourseDocument({ version: 1, blocks: [], lessonNotes: { next: { text: '  \n ' } } }).lessonNotes, undefined);
});

test('预览不修改原始文档与目录，退出预览不会丢失教师编辑信息', () => {
  const source = catalog();
  const document: CourseDocument = { version: 1, blocks: [group('mixed', 'resources', ['r-draft', 'r-open'])] };
  const before = JSON.stringify({ document, source });
  const freeze = (value: unknown) => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } };
  freeze(document); freeze(source);
  const first = courseStudentPreview(document, source);
  const second = courseStudentPreview(document, source);
  assert.deepEqual(first, second); assert.equal(JSON.stringify({ document, source }), before);
  assert.equal(source.assignments[0].assignment?.description, '内部表单数据');
});

test('管理员来源的预览仍指向具体作业详情，不能退化为管理列表', () => {
  const source = catalog();
  source.assignments[1].href = '/courses/course/assignments?edit=open#edit-open';
  const result = courseStudentPreview({ version: 1, blocks: [reference('r', 'assignments', 'open')] }, source);
  assert.equal(result.catalog.assignments.find(record => record.id === 'open')?.href, '/courses/course/assignments/open');
});

test('取消原因属于学生可见内容，应保留在预览而不带出教师处理信息', () => {
  const source = catalog();
  const cancelled = source.assignments.find(record => record.id === 'cancelled')!;
  cancelled.detail = '取消原因：天气原因，免交';
  cancelled.lifecycleLabel = '已取消，不再要求完成';
  cancelled.assignment!.cancellationReason = '天气原因，免交';
  const result = courseStudentPreview({ version: 1, blocks: [reference('r', 'assignments', 'cancelled')] }, source);
  assert.equal(result.catalog.assignments.find(record => record.id === 'cancelled')?.detail, '取消原因：天气原因，免交');
  assert.equal(result.catalog.assignments.find(record => record.id === 'cancelled')?.visibilityStatus, 'CANCELLED');
  assert.equal(result.catalog.assignments.find(record => record.id === 'open')?.detail, undefined);
});

test('学生预览投影 Markdown 原始正文，只保留可读引用和公开记录信息', () => {
  const source = catalog();
  Object.assign(source.assignments.find(record => record.id === 'open')!, { assignmentMode: 'GROUP' });
  Object.assign(source.resources.find(record => record.id === 'r-open')!, { resourceFormat: 'PDF', resourceAction: 'open' });
  const document: CourseDocument = { version: 1, blocks: [createMarkdownBlock('body', [
    '写下自己的判断。先读 [公开资料](course:resources/r-open)，再看 [小组作业](course:assignments/open)。',
    '不可用 [备课资料标题](course:resources/r-draft)、[未来作业标题](course:assignments/draft) 或 [私有组名](course:groups/other-group)。',
    '> [未发布课次名](course:pages/hidden-lesson)',
  ].join('\n\n'))] };
  const result = courseStudentPreview(document, source);
  const serialized = JSON.stringify(result);
  assert.match(serialized, /写下自己的判断|公开资料|小组作业/);
  assert.doesNotMatch(serialized, /备课资料标题|未来作业标题|私有组名|未发布课次名|r-draft|hidden-lesson|other-group|全班已交/);
  assert.equal(result.catalog.assignments.find(record => record.id === 'open')?.assignmentMode, 'GROUP');
  assert.equal(result.catalog.resources.find(record => record.id === 'r-open')?.resourceFormat, 'PDF');
  assert.equal(result.catalog.resources.find(record => record.id === 'r-open')?.resourceAction, 'open');
});
