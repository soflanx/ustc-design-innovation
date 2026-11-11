import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Lexer, type Tokens } from 'marked';
import { collectCourseReferences, createMarkdownBlock, parseCourseDocument, readMarkdownSource, type CourseBlock, type CourseDocument } from '../src/lib/course-document';
import { applyCourseMarkdownSource, courseMarkdownImage, courseMarkdownLink, insertCourseMarkdownLine, projectCourseMarkdownSource } from '../src/lib/course-markdown-source';
import { courseMarkdownReferenceLink } from '../src/lib/course-markdown-references';
import type { CourseDocumentCatalog } from '../src/lib/course-document-view';

const text = (id: string, value: string): CourseBlock => ({ id, type: 'paragraph', props: {}, content: [{ type: 'text', text: value, styles: {} }], children: [] });
const title = (value: string): CourseBlock => ({ ...text('title', value), type: 'heading', props: { level: 1 } });
const catalog: CourseDocumentCatalog = {
  pages: [{ id: '课次-1', title: '原型试用', href: '/lesson' }],
  assignments: [{ id: 'assignment-1', title: '观察报告', href: '/assignment' }],
  resources: [], groups: [],
};

test('普通文字和正式引用在同一份源码中复制移动，未改正文保留旧文档', () => {
  const page: CourseBlock = { id: 'page-ref', type: 'courseRecord', props: { kind: 'pages', recordId: '课次-1', display: 'link' } };
  const assignment: CourseBlock = { id: 'assignment-ref', type: 'courseRecord', props: { kind: 'assignments', recordId: 'assignment-1', display: 'card' } };
  const doc: CourseDocument = { version: 1, titleBlockId: 'title', blocks: [title('教学安排'), text('start', '上周做了试用'), page, assignment, createMarkdownBlock('last', '本周讨论改进。')] };
  const projection = projectCourseMarkdownSource(doc, catalog);
  const pageLink = courseMarkdownReferenceLink('pages', '课次-1', '原型试用');
  const assignmentLink = courseMarkdownReferenceLink('assignments', 'assignment-1', '观察报告');
  assert.equal(projection.source, ['上周做了试用', pageLink, assignmentLink, '本周讨论改进。'].join('\n\n'));
  assert.equal(applyCourseMarkdownSource(doc, projection, projection.source), doc);

  const moved = ['本周讨论改进。', '上周做了试用', pageLink, assignmentLink, pageLink].join('\n\n');
  const edited = applyCourseMarkdownSource(doc, projection, moved);
  assert.equal(edited.blocks[0], doc.blocks[0]);
  assert.equal(edited.blocks.length, 2);
  assert.equal(readMarkdownSource(edited.blocks[1]), moved);
  assert.deepEqual(collectCourseReferences(edited).pageIds, ['课次-1']);
  assert.deepEqual(collectCourseReferences(edited).assignmentIds, ['assignment-1']);
  assert.deepEqual(parseCourseDocument(edited, { home: true }), edited);
});

test('接近旧字数上限的页面保留原有独占引用，同时保存新增文字与句中引用', () => {
  const assignments = Array.from({ length: 25 }, (_, index) => ({ id: 'assignment-old-limit-' + index, title: '观察报告'.repeat(25), href: '/assignment' }));
  const oldReferences: CourseBlock[] = assignments.map((record, index) => ({
    id: 'legacy-ref-' + index, type: 'courseRecord', props: { kind: 'assignments', recordId: record.id, display: 'link' }, children: [],
  }));
  const doc: CourseDocument = { version: 1, blocks: [createMarkdownBlock('long-body', 'a'.repeat(59950)), ...oldReferences] };
  assert.doesNotThrow(() => parseCourseDocument(doc, { home: true }));
  const projection = projectCourseMarkdownSource(doc, { assignments, resources: [], groups: [] });
  assert.ok(projection.source.length > 62000);
  const inline = '句中 ' + courseMarkdownReferenceLink('assignments', assignments[0].id, assignments[0].title) + ' 继续写。';
  const next = applyCourseMarkdownSource(doc, projection, '新增。' + projection.source + '\n\n' + inline);
  assert.deepEqual(next.blocks.filter(block => block.type === 'courseRecord'), oldReferences);
  assert.equal(readMarkdownSource(next.blocks.at(-1)!), inline);
  assert.doesNotThrow(() => parseCourseDocument(next, { home: true }));
});

test('移动旧布局时保留块身份、嵌套样式和独立标题，受限块即使删去标记也保留', () => {
  const styled = { ...text('styled', '旧的样式'), props: { textAlignment: 'center' } };
  const wrapped: CourseBlock = { id: 'wrapper', type: 'toggle', props: { title: '旧折叠' }, children: [title('原题'), styled] };
  const protectedReference: CourseBlock = { id: '__locked_opaque', type: 'protected', props: {}, children: [] };
  const image: CourseBlock = { id: 'image', type: 'image', props: { url: '/test.png', caption: '保留原图说明', previewWidth: 300 } };
  const doc: CourseDocument = { version: 1, titleBlockId: 'title', blocks: [wrapped, text('body', '本次课正文'), protectedReference, image] };
  const projection = projectCourseMarkdownSource(doc);
  const [wrapperLine, body, , imageLine] = projection.source.split('\n\n');
  assert.equal(body, '本次课正文');
  assert.doesNotMatch(projection.source, /旧的样式|保留原图说明|test\.png/);

  const updatedTitle = title('独立新标题');
  const changed = { ...doc, blocks: [{ ...wrapped, children: [updatedTitle, styled] }, ...doc.blocks.slice(1)] };
  const next = applyCourseMarkdownSource(changed, projection, ['本次课正文已改', imageLine, wrapperLine, wrapperLine].join('\n\n'));
  assert.deepEqual(next.blocks.map(block => block.type), ['markdown', 'image', 'toggle', 'protected']);
  assert.equal(next.blocks[1], image);
  assert.equal(next.blocks[2].id, wrapped.id);
  assert.deepEqual(next.blocks[2].children, [updatedTitle, styled]);
  assert.equal(next.blocks[3], protectedReference);
  assert.doesNotMatch(JSON.stringify(next), /course-keep:/);

  const originalSource = applyCourseMarkdownSource(next, projection, projection.source);
  assert.deepEqual(originalSource.blocks, changed.blocks);
  assert.equal(originalSource.titleBlockId, 'title');
});

test('移进围栏或列表的旧块标记保留原块，附近 Markdown 源码完整', () => {
  const original: CourseBlock = { id: 'old', type: 'toggle', props: { title: '旧折叠' }, children: [text('child', '既有内容')] };
  const doc: CourseDocument = { version: 1, blocks: [original] };
  const projection = projectCourseMarkdownSource(doc);
  for (const [source, expected] of [
    ['```md\n上面\n' + projection.source + '\n下面\n```', '```md\n上面\n\n下面\n```'],
    ['- 上面\n- ' + projection.source + ' 同行文字\n- 下面', '- 上面\n-  同行文字\n- 下面'],
  ]) {
    const edited = applyCourseMarkdownSource(doc, projection, source);
    assert.deepEqual(edited.blocks.map(block => block.type), ['markdown', 'toggle']);
    assert.equal(readMarkdownSource(edited.blocks[0]), expected);
    assert.equal(edited.blocks[1], original);
  }
});

test('正文第一行的受管引用留在 Markdown，既有页面标题保持独立', () => {
  const doc: CourseDocument = { version: 1, titleBlockId: 'title', blocks: [title('公开的页面标题')] };
  const projection = projectCourseMarkdownSource(doc);
  const raw = '# ' + courseMarkdownReferenceLink('pages', 'draft', '私有课次');
  const next = applyCourseMarkdownSource(doc, projection, raw);
  assert.equal(next.blocks[0], doc.blocks[0]);
  assert.equal(readMarkdownSource(next.blocks[1]), raw);
  assert.deepEqual(collectCourseReferences(next).pageIds, ['draft']);
});

test('插入独占引用不会拆断列表、链接、表格及代码围栏，未闭合围栏前插入', () => {
  const link = courseMarkdownReferenceLink('assignments', 'assignment-1', '观察报告');
  for (const block of [
    '- 观察\n  - 试用\n- 记录',
    '阅读 [观察指南](/notes) 再讨论。',
    '| 项目 | 记录 |\n| --- | --- |\n| a | b |',
    '```md\n源代码 [示例](/notes)\n```',
  ]) {
    const source = block + '\n\n下一段';
    const result = insertCourseMarkdownLine(source, 5, link);
    assert.equal(result.source, block + '\n\n' + link + '\n\n下一段');
    assert.equal(result.source.slice(result.start), '下一段');
    assert.deepEqual(Lexer.lex(result.source).filter(token => token.type !== 'space').slice(1).map(token => token.type), ['paragraph', 'paragraph']);
  }
  const unclosed = '开头\n\n```md\n尚在写代码';
  assert.equal(insertCourseMarkdownLine(unclosed, unclosed.length, link).source, '开头\n\n' + link + '\n\n```md\n尚在写代码');
  assert.equal(insertCourseMarkdownLine('已有文字', 0, link).source, link + '\n\n已有文字');
  assert.equal(insertCourseMarkdownLine('', 0, link).source, link + '\n\n');
});

test('旧 Markdown 的未闭合围栏和局部链接定义不影响相邻作业及后续段落', () => {
  const code = createMarkdownBlock('unfinished-code', '```md\n原样保留');
  const scoped = createMarkdownBlock('scoped-link', '[内部规则][rule]\n\n[rule]: /rules');
  const reference: CourseBlock = { id: 'old-ref', type: 'courseRecord', props: { kind: 'assignments', recordId: 'assignment-1', display: 'link' } };
  const tail = createMarkdownBlock('tail', '后续说明中的 [rule] 不引用上段。');
  const doc: CourseDocument = { version: 1, blocks: [code, reference, scoped, tail] };
  const projection = projectCourseMarkdownSource(doc, catalog);
  assert.equal(projection.retained.size, 2);
  assert.doesNotMatch(projection.source, /原样保留|\[rule\]:/);
  const edited = applyCourseMarkdownSource(doc, projection, projection.source + '\n\n新增普通说明。');
  assert.equal(edited.blocks[0], code);
  assert.equal(edited.blocks[2], scoped);
  assert.deepEqual(collectCourseReferences(edited).assignmentIds, ['assignment-1']);
  assert.equal(Lexer.lex(readMarkdownSource(edited.blocks[3]))[0].type, 'paragraph');
  assert.doesNotMatch(JSON.stringify(edited), /course-keep:/);
});

test('图片说明和小组工作记录的来源链接可用标准 Markdown 回读', () => {
  const image = courseMarkdownImage('https://example.org/图(1).png', '说明 [A] "原型"');
  const link = courseMarkdownLink('小组工作记录', '/courses/test/groups?fromPage=lesson');
  const [imageToken] = Lexer.lex(image);
  const [linkToken] = Lexer.lex(link);
  assert.equal(imageToken.type, 'paragraph');
  assert.equal(linkToken.type, 'paragraph');
  const imageInline = (imageToken as Tokens.Paragraph).tokens[0], linkInline = (linkToken as Tokens.Paragraph).tokens[0];
  assert.ok(imageInline.type === 'image');
  assert.equal(imageInline.title, '说明 [A] "原型"');
  assert.ok(linkInline.type === 'link');
  assert.equal(linkInline.href, '/courses/test/groups?fromPage=lesson');
});
