import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectCourseReferences, createMarkdownBlock, isSafeCourseUrl } from '../src/lib/course-document';
import { collectCourseMarkdownReferences, courseMarkdownReferenceLink, isCourseMarkdownHref, parseCourseMarkdownReference, projectCourseMarkdownReferences } from '../src/lib/course-markdown-references';

test('课程引用使用唯一的编码目标，标题标点不改变链接含义', () => {
  const id = '课次-四';
  const source = courseMarkdownReferenceLink('pages', id, '读 [题] *原文*\\\n下一行');
  const href = `course:pages/${encodeURIComponent(id)}`;
  assert.ok(source.endsWith(`](${href})`));
  assert.deepEqual(parseCourseMarkdownReference(href), { kind: 'pages', id });
  assert.deepEqual(collectCourseMarkdownReferences(source), [{ kind: 'pages', id }]);
  for (const badHref of ['course:pages/a%2Fb', 'course:pages/%61', 'course:pages/..', 'course:pages/a%0A', 'course:pages/a#other', 'course:pages/%a', 'COURSE:pages/a', 'course&colon;pages/a', 'course:unknown/a']) {
    assert.equal(parseCourseMarkdownReference(badHref), null);
    assert.equal(isCourseMarkdownHref(badHref), true);
  }
  assert.equal(isCourseMarkdownHref('https://course.test/'), false);
  assert.equal(isSafeCourseUrl(href), false);
  assert.equal(isSafeCourseUrl('javascript:alert(1)'), false);
});

test('从实际 Markdown 链接和旧块收集引用，代码、图片替代文字和未使用定义不计入', () => {
  const source = [
    '> 先读 **[课次](course:pages/lesson)**。',
    '- 讨论\n  - [本组](course:groups/group)',
    '| 材料 |\n| --- |\n| [读本][reader] |',
    '[作业](course\\:assignments/exercise) 与 [作业](course:assignments/exercise)',
    '`[代码里的示例](course:pages/code-span)`',
    '```md\n[代码围栏](course:pages/code-fence)\n```',
    '![图片替代文字 [不是链接](course:pages/image-alt)](https://example.org/image.png)',
    '[reader]: course:resources/reader\n[unused]: course:resources/unused',
  ].join('\n\n');
  const doc = { version: 1 as const, blocks: [createMarkdownBlock('source', source), {
    id: 'old-link', type: 'courseRecord' as const, props: { kind: 'resources', recordId: 'reader', display: 'link' },
  }] };
  assert.deepEqual(collectCourseReferences(doc), { assignmentIds: ['exercise'], resourceIds: ['reader'], groupIds: ['group'], pageIds: ['lesson'] });
});

test('读者投影保留正常正文、可读链接和代码，移除受限标题、目标及定义', () => {
  const publicLink = '[阅读](course:pages/live)';
  const code = '`[仅示例](course:pages/sample)`';
  const source = [
    `先读 ${publicLink}，再 **等 [内部资料](course:resources/private-resource) 确认**。${code}`,
    '- [私有小组](course:groups/private-group)\n- 公开组队说明',
    '> [未发布的课次](course:pages/private-page)\n> 受限引文',
    '![私有图名](course:resources/private-image)',
    '移除 [定义中的标题][teacher-only] 与 [保留文字的恶意外链](javascript:alert(1))。',
    '[teacher-only]: course:resources/private-definition "内部定义"',
    '[无法解释的标题](course&colon;pages/private-invalid)',
  ].join('\n\n');
  const projected = projectCourseMarkdownReferences(source, ref => ref.id === 'live');
  for (const text of [publicLink, code, '先读', '再 **等  确认**', '公开组队说明', '保留文字的恶意外链']) assert.ok(projected.includes(text), text);
  assert.doesNotMatch(projected, /private-|内部资料|私有小组|未发布的课次|私有图名|定义中的标题|内部定义|无法解释的标题/);
  assert.deepEqual(collectCourseMarkdownReferences(projected), [{ kind: 'pages', id: 'live' }]);
});

test('被 Markdown 忽略的重复定义也不会留在读者收到的原始正文中', () => {
  const shadowed = '[普通外链][a]\n\n> [a]: https://example.org\n> [a]: course:resources/restricted "仅内部使用"';
  assert.deepEqual(collectCourseMarkdownReferences(shadowed), []);
  assert.doesNotMatch(projectCourseMarkdownReferences(shadowed, () => false), /restricted|仅内部使用/);
});

test('表格里的单个引用撤回时，读者仍可看到表格其他内容', () => {
  const table = '| 课次 | 准备 |\n| :--- | ---: |\n| 工作坊 | [内部报告](course:resources/hidden) 看第 2 页 |\n| 讲评 | 带来草图 \\| 记录 |';
  const visible = projectCourseMarkdownReferences(table, () => false);
  assert.match(visible, /课次 \| 准备/);
  assert.match(visible, /工作坊 \|\s+看第 2 页/);
  assert.match(visible, /讲评 \| 带来草图 \\\| 记录/);
  assert.doesNotMatch(visible, /内部报告|hidden/);
});
