import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMarkdownBlock, normalizeCourseDocument, parseCourseDocument, readMarkdownSource, type CourseBlock } from '../src/lib/course-document';
import type { CourseDocumentCatalog } from '../src/lib/course-document-view';

// Next handles CSS modules in the app. Node only needs the components' markup.
const load = createRequire(import.meta.url);
const previousCssLoader = load.extensions['.css'];
load.extensions['.css'] = module => { module.exports = {}; };
const { CourseMarkdownView } = load('../src/components/course-markdown-view.tsx') as typeof import('../src/components/course-markdown-view');
const { CourseDocumentView } = load('../src/components/course-document-view.tsx') as typeof import('../src/components/course-document-view');
if (previousCssLoader) load.extensions['.css'] = previousCssLoader;
else delete load.extensions['.css'];

const render = (source: string, catalog?: CourseDocumentCatalog, editing = false) =>
  renderToStaticMarkup(createElement(CourseMarkdownView, { source, catalog, editing }));
const documentOf = (...blocks: CourseBlock[]) => ({ version: 1 as const, blocks });
const base = '/courses/2026-fall';
const catalog: CourseDocumentCatalog = {
  pages: [{ id: 'intro', title: '第一课 · 观察与记录', href: `${base}/pages/intro` }],
  assignments: [{
    id: 'prototype', title: '初版原型', href: `${base}/assignments/prototype?fromPage=intro`, assignmentMode: 'GROUP',
    deadline: '2026-11-11T09:00:00.000Z', lifecycleHint: '可提交', visibilityStatus: 'PUBLISHED', scope: 'self', progressHint: '本组已提交',
  }],
  resources: [
    { id: 'notes', title: '观察笔记', href: `${base}/resources/notes/open`, resourceFormat: 'PDF', resourceAction: 'open', actionLabel: '打开 PDF', opensInNewTab: true },
    { id: 'worksheet', title: '访谈工作表', href: `${base}/resources/worksheet/open`, resourceFormat: 'DOCX', resourceAction: 'download', actionLabel: '下载文件' },
  ],
  groups: [],
};

test('完整 Markdown 原稿跨保存与读取保留换行、缩进和特殊字符，可与独立作业并存', () => {
  const source = '## 活动安排  \r\n\r\n- **记录**\n  - 访谈\n\n' + '课'.repeat(13000) + '\n\n```txt\n  # 示意\n```\n';
  const assignment: CourseBlock = { id: 'ref', type: 'courseRecord', props: { kind: 'assignments', recordId: 'assignment-1', display: 'link' }, children: [] };
  const parsed = normalizeCourseDocument(parseCourseDocument(JSON.parse(JSON.stringify(documentOf(createMarkdownBlock('body', source), assignment)))));
  assert.equal(readMarkdownSource(parsed.blocks[0]), source);
  assert.deepEqual(parsed.blocks[1], assignment);
  assert.throws(() => parseCourseDocument(documentOf(createMarkdownBlock('body', 'a'.repeat(60001)))), /60000/);
});

test('Markdown 原稿仅接受普通文本，与教学引用和旧富文本的格式分开校验', () => {
  const body = createMarkdownBlock('body', '课前');
  const nested: CourseBlock = { id: 'nested', type: 'courseRecord', props: { kind: 'assignments', recordId: 'a', display: 'link' }, children: [] };
  assert.deepEqual(parseCourseDocument(documentOf({ ...body, children: [nested] })).blocks[0].children, [nested]);
  assert.throws(() => parseCourseDocument(documentOf({ ...body, content: [{ type: 'text', text: '课前', styles: { bold: true } }] })), /文本标记/);
  assert.throws(() => parseCourseDocument(documentOf({ ...body, content: [{ type: 'link', href: '/courses', content: [] }] })));
  assert.equal(readMarkdownSource(parseCourseDocument(documentOf({ ...body, content: [
    { type: 'text', text: '课前', styles: {} }, { type: 'text', text: '\n准备', styles: {} },
  ] })).blocks[0]), '课前\n准备');
});

test('阅读态将标题、嵌套列表、行内格式、引用、代码、链接和图片排版', () => {
  const html = render('# 观察\n\n- **原型**\n  - *迭代*\n\n> 记录\n\n```txt\n# 标题示例\n```\n\n[作业](/courses/1)\n\n![对比](/images/prototype.png)');
  for (const markup of ['<h2>观察</h2>', '<ul><li><strong>原型</strong><ul><li><em>迭代</em>', '<blockquote><p>记录</p>', '<pre><code># 标题示例</code></pre>', 'href="/courses/1"', 'alt="对比"', 'src="/images/prototype.png"']) assert.ok(html.includes(markup), markup);
});

test('正文 HTML 显示为文字，不安全链接和图片不会产生可执行或加载元素', () => {
  const html = render('<script>alert(1)</script>\n\n[危险](javascript:alert) ![像素](//example.com/pixel) [编码](jav&#x61;script:evil)\n\n![数据](data:image/png;base64,abc)');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /危险/);
  assert.match(html, /像素/);
  assert.doesNotMatch(html, /<script|<img|<a\s|href=|src=/);
});

test('同一句和列表中的教学引用用原件标题和链接连续阅读', () => {
  const html = render('先看[旧课名](course:pages/intro)，再做[旧作业名](course:assignments/prototype)。\n\n- [旧文件名](course:resources/worksheet)', catalog);
  assert.match(html, /<p>先看<a [^>]+>第一课 · 观察与记录<\/a>，再做<a [^>]+>初版原型<\/a><span[^>]*>（<time datetime="2026-11-11T09:00:00\.000Z"[^>]*>[^<]+ 截止<\/time>）<\/span>。<\/p>/i);
  assert.match(html, /<li><a [^>]+>访谈工作表<\/a><\/li>/);
  for (const href of [`${base}/pages/intro`, `${base}/assignments/prototype?fromPage=intro`, `${base}/resources/worksheet/open`]) {
    assert.ok(html.includes(`href="${href}"`), href);
  }
  assert.doesNotMatch(html, /<article|本组已提交|course:|旧课名|旧作业名|旧文件名/);
});

test('独占一段的教学引用呈现有范围的作业状态与资料动作', () => {
  const source = '[作业](course:assignments/prototype)\n\n[资料](course:resources/notes)\n\n[表格](course:resources/worksheet)';
  const html = render(source, catalog);
  const links = [...html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gu)];
  const pdf = links.find(([, attributes]) => attributes.includes('href="' + base + '/resources/notes/open"'));
  const worksheet = links.find(([, attributes]) => attributes.includes('href="' + base + '/resources/worksheet/open"'));
  assert.match(html, /<article [^>]+data-course-reference="assignments"[^>]+data-assignment-scope="self"/);
  assert.match(html, /小组提交.*<time datetime="2026-11-11T09:00:00\.000Z"[^>]*>[^<]+ 截止<\/time>.*本组已提交/iu);
  assert.ok(pdf && worksheet);
  assert.match(pdf[1], /target="_blank"/);
  assert.match(pdf[2], /PDF<\/span>.*打开<\/span>/u);
  assert.doesNotMatch(worksheet[1], /target=/);
  assert.match(worksheet[2], /DOCX<\/span>.*下载<\/span>/u);
  assert.doesNotMatch(html, /<p>|<details|可提交/);

  const staff = render(source, { ...catalog, assignments: [{
    ...catalog.assignments[0], scope: 'mine', progressHint: '负责范围待评阅 2 份', secondaryHref: '/staff-only', secondaryLabel: '提交统计',
  }] });
  assert.match(staff, /href="\/courses\/2026-fall\/assignments\/prototype\?fromPage=intro"/);
  assert.doesNotMatch(staff, /待评阅|\/staff-only|提交统计/);
});

test('作业取消与草稿仍可辨认，预览中的原件用新标签页打开', () => {
  const html = render('[作业](course:assignments/prototype)\n\n[课次](course:pages/intro)', {
    ...catalog,
    assignments: [{ ...catalog.assignments[0], visibilityStatus: 'CANCELLED' }],
    pages: [{ ...catalog.pages![0], status: '草稿' }],
  }, true);
  assert.match(html, /已取消，免交/);
  assert.match(html, /<a (?=[^>]*href="\/courses\/2026-fall\/pages\/intro")(?=[^>]*target="_blank")[^>]*>/);
  assert.match(html, /草稿/);
  assert.doesNotMatch(html, /<time|本组已提交/);
});

test('句中、列表和学生预览的作业保留实际截止，取消后不再显示旧截止', () => {
  const { courseStudentPreview } = load('../src/lib/course-student-preview') as typeof import('../src/lib/course-student-preview');
  const source = '请做[旧名](course:assignments/prototype)。\n\n- [旧名](course:assignments/prototype)';
  const html = render(source, catalog);
  assert.equal([...html.matchAll(/datetime="2026-11-11T09:00:00\.000Z"/gi)].length, 2);
  assert.equal([...html.matchAll(/初版原型/g)].length, 4); // Visible titles and accessible link names.
  const cancelled = courseStudentPreview(documentOf(createMarkdownBlock('body', source)), {
    ...catalog, assignments: [{ ...catalog.assignments[0], visibilityStatus: 'CANCELLED' }],
  });
  const preview = renderToStaticMarkup(createElement(CourseDocumentView, { ...cancelled, editing: true }));
  assert.equal([...preview.matchAll(/已取消，免交/g)].length, 2);
  assert.doesNotMatch(preview, /<time|本组已提交|2026-11-11/);
  assert.match(preview, /target="_blank"/);
  assert.match(render(source, { ...catalog, assignments: [{ ...catalog.assignments[0], deadline: undefined }] }), /未设截止/);
});

test('不可读和无效教学引用不显示原标题、标识或空段落', () => {
  const html = render('[私密材料](course:resources/hidden)\n\n前[旧小组](course:groups/hidden)后 ![隐图](course:resources/notes)\n\n[无效引用](course:other/hidden)\n\n[![私密材料](course:resources/hidden)](/resources)', catalog);
  assert.equal(html, '<p>前后 </p>');
});

test('带说明的独立 Markdown 图片显示图注，行内图片留在段落里', () => {
  const html = render('![观察图](/images/observations.png "第 2 次观察")\n\n再看![略图](/images/summary.png "另一张图")。');
  assert.match(html, /<figure data-markdown-image="true"><img [^>]*alt="观察图"[^>]*\/><figcaption>第 2 次观察<\/figcaption><\/figure>/);
  assert.match(html, /<p>再看<img [^>]*alt="略图"[^>]*\/>。<\/p>/);
});

test('文档读取同时呈现 Markdown 引用和带撤回提示的旧资料引用', () => {
  const document = documentOf(
    createMarkdownBlock('lesson', '课前阅读[原课次](course:pages/intro)。'),
    { id: 'legacy', type: 'courseRecord', props: { kind: 'resources', recordId: 'notes', display: 'card' }, children: [] },
  );
  const html = renderToStaticMarkup(createElement(CourseDocumentView, {
    document, catalog: { ...catalog, resources: [{ ...catalog.resources[0], status: '已撤回 · 学生不可见' }] },
  }));
  assert.match(html, /<p>课前阅读<a [^>]+>第一课 · 观察与记录<\/a>。<\/p>/u);
  assert.match(html, /data-display="card" data-course-reference="resources"/);
  assert.match(html, /观察笔记.*已撤回 · 学生不可见/u);
});

test('Markdown 经过布局编辑仍保留原稿、样式和嵌套记录', async () => {
  const { markdownLayoutBlocks } = await import('../src/lib/course-document-layout');
  const source = '  # 保留缩进\n\n- **原型**\n  - 对照\n\n```js\n    a < b\n```\n';
  const markdown = { ...createMarkdownBlock('source', source), props: { textAlignment: 'center', textColor: 'blue' },
    children: [{ id: 'task', type: 'courseRecord', props: { kind: 'assignments', recordId: 'a1', display: 'card' }, children: [] } as CourseBlock] };
  const layout = JSON.parse(JSON.stringify(markdownLayoutBlocks([markdown], true)));
  assert.equal(layout[0].props.source, source);
  assert.deepEqual(parseCourseDocument(documentOf(...markdownLayoutBlocks(layout, false))).blocks, [markdown]);
});
