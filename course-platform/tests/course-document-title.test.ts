import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  courseDocumentTitle, courseTitleBlock, CourseDocumentError, ensureCoursePageTitle,
  expandCourseHomeLessonNotes, normalizeCourseDocument, parseCourseDocument, retainCourseTitleReference,
  type CourseBlock, type CourseDocument,
} from '../src/lib/course-document';

const paragraph = (id: string, text = '正文'): CourseBlock => ({ id, type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] });
const doc = (...blocks: CourseBlock[]): CourseDocument => ({ version: 1, blocks });

test('旧页面标题只提升一次为普通标题块，稳定避开已有ID且不改写原内容', () => {
  const old = doc(paragraph('course-page-title'), paragraph('body'));
  const before = structuredClone(old);
  const migrated = ensureCoursePageTitle(old, '原型测试');
  assert.deepEqual(old, before);
  assert.equal(migrated.titleBlockId, 'course-page-title-1');
  assert.equal(migrated.blocks[0].type, 'heading');
  assert.deepEqual(migrated.blocks[0].props, { level: 1 });
  assert.equal(courseDocumentTitle(migrated), '原型测试');
  assert.deepEqual(ensureCoursePageTitle(migrated, '已过时的元数据'), migrated);
  assert.deepEqual(parseCourseDocument(migrated), migrated);
  assert.deepEqual(normalizeCourseDocument(migrated), migrated);
});

test('标题移到正文之后或嵌套位置仍按ID读取，保存再打开不补回顶部标题', () => {
  const migrated = ensureCoursePageTitle(doc(paragraph('body')), '原型测试');
  const title = migrated.blocks[0];
  const moved = { ...migrated, blocks: [migrated.blocks[1], title] };
  const reopened = ensureCoursePageTitle(parseCourseDocument(moved), '旧标题');
  assert.deepEqual(reopened.blocks.map(block => block.id), ['body', title.id]);
  const nested = { ...moved, blocks: [{ ...paragraph('section'), children: [title] }] };
  assert.equal(courseTitleBlock(parseCourseDocument(nested))?.id, title.id);
  assert.equal(courseDocumentTitle(nested), '原型测试');
  assert.deepEqual(ensureCoursePageTitle(nested, '旧标题'), nested);
});

test('删除或转换标题后不再自动插入，Undo能恢复同一个标题身份', () => {
  const migrated = ensureCoursePageTitle(doc(paragraph('body')), '原型测试');
  const id = migrated.titleBlockId!;
  const deleted = retainCourseTitleReference(doc(migrated.blocks[1]), id);
  assert.equal(deleted.titleBlockId, null);
  assert.deepEqual(ensureCoursePageTitle(deleted, '原型测试'), deleted);
  assert.deepEqual(parseCourseDocument(deleted), deleted);
  assert.equal(courseDocumentTitle(deleted, '原型测试'), '原型测试');
  const converted = retainCourseTitleReference(doc({ ...migrated.blocks[0], type: 'paragraph', props: {} }, migrated.blocks[1]), id);
  assert.equal(converted.titleBlockId, null);
  const undone = retainCourseTitleReference(doc(...migrated.blocks), id);
  assert.equal(undone.titleBlockId, id);
  assert.equal(courseDocumentTitle(undone), '原型测试');
});

test('标题元数据取完整行内文字并保持长度限制，错误标题引用不能保存', () => {
  const migrated = ensureCoursePageTitle(doc(), '');
  const title = migrated.blocks[0];
  title.content = [{ type: 'text', text: '  原型\n', styles: { bold: true } }, { type: 'link', href: '/courses', content: [{ type: 'text', text: '测试  ', styles: {} }] }];
  assert.equal(courseDocumentTitle(migrated), '原型 测试');
  title.content = [{ type: 'text', text: '长'.repeat(120), styles: {} }];
  assert.equal(courseDocumentTitle(migrated).length, 100);
  assert.equal((courseTitleBlock(migrated)?.content?.[0] as { text: string }).text.length, 120);
  for (const invalid of [
    { ...migrated, titleBlockId: 'missing' },
    { ...doc(paragraph('body')), titleBlockId: 'body' },
    { ...migrated, titleBlockId: 1 },
    { ...migrated, blocks: [{ ...title, props: { level: 2 } }] },
  ]) assert.throws(() => parseCourseDocument(invalid), CourseDocumentError);
});

test('已有250个内容块的页面可加入原本独立的标题，不删减正文', () => {
  const old = doc(...Array.from({ length: 250 }, (_, index) => paragraph(`paragraph-${index}`)));
  const migrated = ensureCoursePageTitle(old, '课程页面');
  assert.equal(parseCourseDocument(migrated).blocks.length, 251);
  assert.throws(() => parseCourseDocument({ ...migrated, blocks: [...migrated.blocks, paragraph('too-many')] }), CourseDocumentError);
});

test('已达到旧上限的首页仍能把两段旧提示及引用保存为普通正文', () => {
  const old = ensureCoursePageTitle(doc(...Array.from({ length: 250 }, (_, index) => paragraph(`paragraph-${index}`))), '课程首页');
  old.lessonNotes = {
    previous: { text: '回看本节课。', pageId: 'lesson-a' },
    next: { text: '带一张记录。', pageId: 'lesson-b' },
  };
  const expanded = expandCourseHomeLessonNotes(old);
  assert.equal(expanded.lessonNotes, undefined);
  assert.deepEqual(expanded.blocks.slice(5), old.blocks.slice(1));
  assert.deepEqual(parseCourseDocument(expanded, { home: true }), expanded);
  assert.throws(() => parseCourseDocument(expanded), CourseDocumentError);
});
