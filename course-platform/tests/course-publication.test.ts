import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CourseBlock, CourseDocument } from '../src/lib/course-document';
import type { CourseDocumentCatalog, CourseDocumentRecord } from '../src/lib/course-document-view';
import { courseRecordSaveImpact, summarizeCoursePublication } from '../src/lib/course-publication';

const record = (id: string, visibilityStatus: CourseDocumentRecord['visibilityStatus']): CourseDocumentRecord => ({ id, title: `不应进入摘要的标题 ${id}`, href: '/records', detail: '不应进入摘要的正文', visibilityStatus });
const one = (id: string, kind: 'assignments' | 'resources' | 'pages', recordId: string): CourseBlock => ({ id, type: 'courseRecord', props: { kind, recordId }, children: [] });
const many = (id: string, kind: 'assignments' | 'resources', ids: string[], children: CourseBlock[] = []): CourseBlock => ({ id, type: 'courseData', props: { kind, ids: JSON.stringify(ids) }, children });
const doc = (...blocks: CourseBlock[]): CourseDocument => ({ version: 1, blocks });
const catalog = (): CourseDocumentCatalog => ({ assignments: [record('a-open', 'PUBLISHED'), record('a-draft', 'DRAFT'), record('a-ended', 'ARCHIVED'), record('a-cancelled', 'CANCELLED')], resources: [record('r-open', 'PUBLISHED'), record('r-draft', 'DRAFT'), record('r-withdrawn', 'ARCHIVED')], groups: [] });

test('发布摘要递归提取并按正式记录去重，区分学生可读的已结束/取消和不可见草稿/撤回', () => {
  const summary = summarizeCoursePublication(doc(
    one('repeat', 'assignments', 'a-open'),
    many('assignments', 'assignments', ['a-open', 'a-draft', 'a-ended', 'a-cancelled'], [one('child', 'resources', 'r-open')]),
    many('resources', 'resources', ['r-open', 'r-draft', 'r-withdrawn', 'r-open']),
  ), catalog());
  assert.deepEqual(summary.assignments, { total: 4, draft: 1, published: 1, ended: 1, cancelled: 1, unknown: 0 });
  assert.deepEqual(summary.resources, { total: 3, draft: 1, published: 1, withdrawn: 1, unknown: 0 });
  assert.equal(summary.hiddenCount, 3);
  assert.equal(summary.needsConfirmation, true);
  assert.ok(!JSON.stringify(summary).includes('不应进入摘要'));
});

test('只引用公开、结束、取消记录的页面直接发布，无关联页也不额外确认', () => {
  const summary = summarizeCoursePublication(doc(many('tasks', 'assignments', ['a-open', 'a-ended', 'a-cancelled']), one('resource', 'resources', 'r-open')), catalog());
  assert.equal(summary.needsConfirmation, false);
  assert.equal(summary.hiddenCount, 0);
  assert.equal(summarizeCoursePublication(doc(), catalog()).needsConfirmation, false);
});

test('旧目录不含子页时保留原有发布规则，含未能解析的子页引用时核对具体状态', () => {
  const oldCatalog = catalog();
  const document = doc(one('page', 'pages', 'p1'));
  const missing = summarizeCoursePublication(document, oldCatalog);
  assert.deepEqual(missing.pages, { total: 1, published: 0, draft: 0, unknown: 1 });
  assert.equal(missing.unknownCount, 1);
  assert.equal(missing.needsConfirmation, true);
  const found = summarizeCoursePublication(document, { ...oldCatalog, pages: [record('p1', 'PUBLISHED')] });
  assert.equal(found.needsConfirmation, false);
  assert.notEqual(found.key, missing.key);
});

test('助教的受保护资料只提示存在，不猜数量或暴露隐藏标题、正文、真实记录ID', () => {
  const source: CourseDocumentCatalog = { assignments: [], resources: [record('r-open', 'PUBLISHED')], groups: [] };
  const summary = summarizeCoursePublication(doc(one('public', 'resources', 'r-open'), { id: '__locked_opaque', type: 'protected', props: {}, children: [] }), source);
  assert.equal(summary.resources.total, 1);
  assert.equal(summary.hasProtectedReferences, true);
  assert.equal(summary.needsConfirmation, true);
  assert.equal(summary.hiddenCount, 0);
  assert.ok(!JSON.stringify(summary).includes('不应进入摘要'));
});

test('引用消失或缺状态不能当作已发布；状态交换即使总数相同也必须重新核对', () => {
  const page = doc(many('tasks', 'assignments', ['a-open', 'a-draft']), one('missing', 'resources', 'not-readable'));
  const first = summarizeCoursePublication(page, catalog());
  assert.equal(first.resources.unknown, 1);
  assert.equal(first.needsConfirmation, true);
  const changed = catalog();
  changed.assignments[0].visibilityStatus = 'DRAFT';
  changed.assignments[1].visibilityStatus = 'PUBLISHED';
  const second = summarizeCoursePublication(page, changed);
  assert.deepEqual(first.assignments, second.assignments);
  assert.notEqual(first.key, second.key);
  const reordered = doc(one('missing', 'resources', 'not-readable'), many('tasks', 'assignments', ['a-draft', 'a-open', 'a-open']));
  assert.equal(summarizeCoursePublication(reordered, catalog()).key, first.key);
});

test('只读取visibilityStatus，与学生预览一致，不用管理表单状态猜测可见性', () => {
  const source = catalog();
  source.assignments[0].visibilityStatus = undefined;
  source.assignments[0].assignment = { title: '私有', description: '私有正文', mode: 'INDIVIDUAL', status: 'PUBLISHED', dueAt: '', versionCount: 0, revision: 1, maxScore: 100, cancellationReason: null };
  const summary = summarizeCoursePublication(doc(one('a', 'assignments', 'a-open')), source);
  assert.equal(summary.assignments.unknown, 1);
  assert.equal(summary.assignments.published, 0);
});

test('记录保存影响区分立即更新、恢复要求、结束/取消与资料改回草稿', () => {
  assert.match(courseRecordSaveImpact('assignments', 'PUBLISHED', 'PUBLISHED'), /立即更新学生可见要求.*页面草稿不会延迟/);
  assert.match(courseRecordSaveImpact('resources', 'PUBLISHED', 'PUBLISHED'), /立即更新学生和助教可见的资料/);
  assert.match(courseRecordSaveImpact('resources', 'DRAFT', 'PUBLISHED'), /立即无法读取/);
  assert.match(courseRecordSaveImpact('assignments', 'DRAFT'), /可在课次发布时选择一并发布/);
  assert.match(courseRecordSaveImpact('assignments', 'CANCELLED', 'PUBLISHED'), /不再需要完成.*已有提交和反馈保留/);
  assert.match(courseRecordSaveImpact('assignments', 'PUBLISHED', 'CANCELLED'), /重新需要完成/);
  assert.match(courseRecordSaveImpact('assignments', 'ARCHIVED', 'PUBLISHED'), /立即结束提交/);
  assert.match(courseRecordSaveImpact('resources', 'ARCHIVED', 'ARCHIVED'), /仍不可见/);
});
