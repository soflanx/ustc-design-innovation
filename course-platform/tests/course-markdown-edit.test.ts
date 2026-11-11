import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMarkdownBlock, parseCourseDocument, readMarkdownSource, type CourseBlock, type CourseDocument } from '../src/lib/course-document';
import { adjacentWritingDrop, dropWritingObject, editWritingArea, insertWritingObject, moveWritingObject, removeWritingObject, writingAreas, writingDropOffsets } from '../src/lib/course-markdown-edit';
import { markdownLayoutBlocks } from '../src/lib/course-document-layout';
import { groupWorkHref } from '../src/lib/group-work-link';

const record: CourseBlock = { id: 'a1', type: 'courseRecord', props: { kind: 'assignments', recordId: 'assignment-1', display: 'card' } };
const paragraph = (id: string, text: string): CourseBlock => ({ id, type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }] });
const texts = (doc: CourseDocument) => writingAreas(doc).filter(x => x.type === 'text');

test('连续正文在换行、粘贴、以及后续多段输入时仍是同一份 Markdown', () => {
  let doc: CourseDocument = { version: 1, blocks: [] };
  for (const source of ['观察', '观察\n\n', '观察\n\n- 原型\n- 测试']) {
    doc = editWritingArea(doc, texts(doc)[0], source);
    assert.equal(doc.blocks.length, 1);
    assert.equal(readMarkdownSource(doc.blocks[0]), source);
    assert.equal(texts(doc)[0].source, source);
  }
  assert.deepEqual(parseCourseDocument(doc), doc);
});

test('在正文中间插入引用保留两侧原文和顺序，移除引用后原文重新连续', () => {
  const source = '标题\n\n第一句末尾｜第二句之后。';
  const doc: CourseDocument = { version: 1, blocks: [createMarkdownBlock('md', source)] };
  const split = source.indexOf('｜');
  const next = insertWritingObject(doc, texts(doc)[0], split, record);
  assert.deepEqual(next.blocks.map(b => b.type), ['markdown', 'courseRecord', 'markdown']);
  assert.deepEqual(texts(next).map(p => p.source), [source.slice(0, split), source.slice(split)]);
  assert.equal(next.blocks[1], record);
  assert.equal(readMarkdownSource(removeWritingObject(next, record.id).blocks[0]), source);
  assert.equal(readMarkdownSource(doc.blocks[0]), source);
});

test('活动中的小组工作记录普通链接保留来源页，跨模式仍可移动，移除会接回原文', () => {
  const body = createMarkdownBlock('activity', '比较两次访谈，再写结论。');
  const doc: CourseDocument = { version: 1, blocks: [body] };
  const link: CourseBlock = { id: 'work', type: 'paragraph', props: {}, content: [{
    type: 'link', href: groupWorkHref('course', 'lesson'), content: [{ type: 'text', text: '小组工作记录', styles: {} }],
  }] };
  const inserted = insertWritingObject(doc, texts(doc)[0], 6, link);
  assert.deepEqual(texts(inserted).map(area => area.source), ['比较两次访谈', '，再写结论。']);
  const roundTrip = parseCourseDocument({ ...inserted, blocks: markdownLayoutBlocks(markdownLayoutBlocks(inserted.blocks, true), false) });
  const moved = moveWritingObject(roundTrip, 'work', 1);
  assert.equal(moved.blocks.at(-1)?.id, 'work');
  assert.deepEqual(moved.blocks.at(-1)?.content, link.content);
  assert.equal(texts(removeWritingObject(roundTrip, 'work'))[0].source, readMarkdownSource(body));
});

test('只编辑中间的旧段落，其他标题、邻段及复杂样式保留原始结构', () => {
  const title: CourseBlock = { ...paragraph('title', '研究计划'), type: 'heading', props: { level: 1 } };
  const doc: CourseDocument = { version: 1, titleBlockId: 'title', blocks: [
    title, paragraph('left', 'A'), paragraph('edit', 'B'), paragraph('right', 'C'),
    { ...paragraph('nested', '旧内容'), children: [paragraph('child', '重要')] },
    { ...paragraph('styled', ''), content: [{ type: 'text', text: '重要', styles: { underline: true } }] },
  ] };
  const editable = texts(doc)[0];
  assert.equal(editable.source, 'A\n\nB\n\nC');
  assert.equal(editWritingArea(doc, editable, editable.source), doc);
  const changed = editWritingArea(doc, editable, 'A\n\n**更新**\n\nC');
  assert.equal(readMarkdownSource(changed.blocks[2]), '**更新**');
  for (const index of [0, 1, 3, 4, 5]) assert.equal(changed.blocks[index], doc.blocks[index]);
  assert.equal(changed.titleBlockId, doc.titleBlockId);
});

test('页面首尾都可以插入对象并接着写作，受保护引用与页面标题不能移动', () => {
  const title: CourseBlock = { ...paragraph('title', '页面'), type: 'heading', props: { level: 1 } };
  const locked: CourseBlock = { id: '__locked_a', type: 'protected', props: {} };
  const doc: CourseDocument = { version: 1, titleBlockId: title.id, blocks: [title, locked] };
  const before = insertWritingObject(doc, texts(doc)[0], 0, record);
  assert.deepEqual(before.blocks.map(b => b.id), [title.id, record.id, locked.id]);
  assert.equal(moveWritingObject(before, record.id, 1), before);
  assert.equal(moveWritingObject(before, record.id, -1), before);
  assert.equal(removeWritingObject(before, locked.id), before);
  const last = texts(before).at(-1)!;
  const next = editWritingArea(before, last, '在引用后继续写');
  assert.equal(readMarkdownSource(next.blocks.at(-1)!), '在引用后继续写');
});

test('明确替换单段 Markdown 的选中文字，只替换选区而不删两侧正文', () => {
  const doc: CourseDocument = { version: 1, blocks: [createMarkdownBlock('m', '说明：旧作业链接。请阅读')] };
  const source = texts(doc)[0];
  const start = source.source.indexOf('旧作业链接');
  const inserted = insertWritingObject(doc, source, start, record, start + '旧作业链接'.length);
  assert.deepEqual(texts(inserted).map(p => p.source), ['说明：', '。请阅读']);
  assert.equal(readMarkdownSource(doc.blocks[0]), '说明：旧作业链接。请阅读');
});

test('包含子内容的标题或 Markdown 只作完整对象，别处写字不会修改内部结构', () => {
  const nested = { ...createMarkdownBlock('outer', '**原格式**'), children: [paragraph('inside', '原图片旁注')] };
  const title: CourseBlock = { ...paragraph('heading', '标题'), type: 'heading', props: { level: 1 }, children: [nested] };
  const doc: CourseDocument = { version: 1, titleBlockId: title.id, blocks: [title, nested] };
  assert.deepEqual(writingAreas(doc).filter(a => a.type === 'object').map(a => a.block), [title, nested]);
  const changed = editWritingArea(doc, texts(doc).at(-1)!, '补充');
  assert.equal(changed.blocks[0], title);
  assert.equal(changed.blocks[1], nested);
  const styled = { ...createMarkdownBlock('color', '有颜色'), props: { textColor: 'blue' } };
  const retained = removeWritingObject({ version: 1, blocks: [styled, record, nested] }, record.id);
  assert.deepEqual(retained.blocks, [styled, nested]);
});

test('把引用拖到连续 Markdown 段落之间会保留完整源文、块 ID、旧样式和教学关联', () => {
  const source = '第一段很长。\n\n## 测试目标\n\n- 观察一\n  - 详细记录\n- 观察二\n\n```md\n代码内\n\n空行\n```\n\n总结。';
  const body = createMarkdownBlock('prose', source);
  const old = { ...paragraph('legacy', '带旁注的旧格式'), children: [paragraph('note', '旁注')] };
  const doc: CourseDocument = { version: 1, blocks: [record, old, body] };
  const cuts = writingDropOffsets(body);
  assert.deepEqual(cuts, ['## 测试目标', '- 观察一', '```md', '总结。'].map(x => source.indexOf(x)));
  const offset = cuts[2];
  const next = dropWritingObject(doc, record.id, { index: 2, offset });
  assert.equal(next.blocks[0], old);
  assert.equal(next.blocks[2], record);
  assert.equal(next.blocks[1].id, body.id);
  assert.notEqual(next.blocks[3].id, body.id);
  assert.deepEqual([readMarkdownSource(next.blocks[1]), readMarkdownSource(next.blocks[3])], [source.slice(0, offset), source.slice(offset)]);
  assert.doesNotThrow(() => parseCourseDocument(next));
  assert.equal(dropWritingObject(doc, record.id, { index: 2, offset: source.indexOf('空行') }), doc);
});

test('直接拖动与菜单移动共享落点，禁止跨越含标题或受保护子内容的边界', () => {
  const body = createMarkdownBlock('text', '观察。\n\n第二段。');
  const old = { ...paragraph('outer', '旧格式'), children: [{ ...paragraph('title', '课程标题'), type: 'heading' as const, props: { level: 1 } }] };
  const lock: CourseBlock = { id: '__locked_work', type: 'protected', props: {} };
  const locked = { ...paragraph('reserved', '旧格式'), children: [lock] };
  const doc: CourseDocument = { version: 1, titleBlockId: 'title', blocks: [old, record, body, locked] };
  assert.equal(dropWritingObject(doc, record.id, { index: 0, offset: 0 }), doc);
  assert.equal(dropWritingObject(doc, record.id, { index: 4, offset: 0 }), doc);
  assert.equal(dropWritingObject(doc, record.id, { index: 2, offset: 0 }), doc);
  const target = adjacentWritingDrop(doc, record.id, 1)!;
  assert.deepEqual(target, { index: 2, offset: '观察。\n\n'.length });
  const moved = moveWritingObject(doc, record.id, 1);
  assert.equal(moved.blocks[2], record);
  assert.equal(moved.titleBlockId, doc.titleBlockId);
  assert.equal(moved.blocks.at(-1), locked);
  assert.deepEqual(doc.blocks, [old, record, body, locked]);
  assert.deepEqual(writingDropOffsets(createMarkdownBlock('definitions', '[链接][x]\n\n[x]: /work')), []);
});
