import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignmentMaterialLink, assignmentMaterialText, splitAssignmentMaterialLinks } from '../src/lib/assignment-material-links';

const offering = '实践Ⅰ-秋';
const resource = { id: '提纲_01', title: '现场[观察]\\访谈提纲（A、B）.pdf' };
const link = assignmentMaterialLink(offering, resource);

test('资料标题与原链接可分别取回，紧邻的中英文标点及空行由正文保留', () => {
  assert.equal(link, `[现场\\[观察\\]\\\\访谈提纲（A、B）.pdf](/courses/${encodeURIComponent(offering)}/resources/${encodeURIComponent(resource.id)}/open)`);
  const description = `要求：\r\n\r\n先读（${link}），再读${link}.\n每组一份。`;
  const parts = splitAssignmentMaterialLinks(description, offering);
  const material = { text: resource.title, resourceId: resource.id, raw: link };
  assert.deepEqual(parts, [
    { text: '要求：\r\n\r\n先读（' }, material, { text: '），再读' }, material, { text: '.\n每组一份。' },
  ]);
  assert.equal(parts.map(part => part.raw ?? part.text).join(''), description);
  assert.equal(assignmentMaterialText(description, offering), description.replaceAll(link, resource.title));
});

test('只认同一期的规范相对路径，不把任意作业文字或地址变成链接', () => {
  const route = '/courses/term/resources/r1/open';
  for (const href of [
    'https://example.org', 'https://example.org' + route, '//example.org' + route, 'javascript:alert(1)', '#资料',
    '/courses/other/resources/r1/open', '/courses/term/assignments/r1/open', route + '?download=1', route + '#intro',
    route + '/', './' + route, '/courses/%74erm/resources/r1/open', '/courses/term/resources/r1/open/../open',
    ...['.', '..', '%2e%2e', 'a%2Fb', '%5C', '%252f', '%00', 'a%0Ab', 'a%23b', 'a%3Fb', '%72%31', '%zz', '%FF', '', 'a'.repeat(201)]
      .map(id => `/courses/term/resources/${id}/open`),
  ]) {
    const original = `老师原文：[资料](${href})。\n`;
    assert.deepEqual(splitAssignmentMaterialLinks(original, 'term'), [{ text: original }], href);
  }
  for (const original of ['', '旧说明\n\n**先阅读**', `<a href="${route}">资料</a>`, `[](${route})`, `[${'a'.repeat(101)}](${route})`]) {
    assert.deepEqual(splitAssignmentMaterialLinks(original, 'term'), [{ text: original }]);
  }
});

test('Markdown 中的图片、转义、代码示例保留原文，之后的独立资料可正常打开', () => {
  const backtick = String.fromCharCode(96);
  const codeFence = backtick.repeat(3);
  const source = [`!${link}`, `\\${link}`, `${backtick}${link}${backtick}`, `${backtick}示例\n${link}${backtick}`, codeFence + 'md', link, codeFence, '~~~', link, '~~~', ''].join('\n');
  assert.deepEqual(splitAssignmentMaterialLinks(source + link, offering), [
    { text: source }, { text: resource.title, resourceId: resource.id, raw: link },
  ]);
  for (const prefix of [codeFence + '示例' + codeFence + '。', '旧要求含有一个 ' + backtick + '，现在看']) {
    assert.deepEqual(splitAssignmentMaterialLinks(prefix + link, offering), [
      { text: prefix }, { text: resource.title, resourceId: resource.id, raw: link },
    ]);
  }
});

test('资料标题中的括号、连续反斜线及末尾反斜线均可往返', () => {
  for (const title of ['[]', '\\', '前\\[中]后\\', '[]\\\\[]', '（访谈）[A].pdf', '。'.repeat(100)]) {
    const raw = assignmentMaterialLink('term-1', { id: 'r1', title });
    assert.deepEqual(splitAssignmentMaterialLinks(raw, 'term-1'), [{ text: title, resourceId: 'r1', raw }]);
  }
});

test('损坏的旧文本保留整段，大量未配对的括号、转义和超长标识不会吞掉后续链接', () => {
  const malformed = '['.repeat(50000) + '\\]'.repeat(50000) + '[长](/courses/term/resources/' + 'a'.repeat(100000) + '/open)\n';
  const raw = assignmentMaterialLink('term', { id: 'r', title: '提纲' });
  assert.deepEqual(splitAssignmentMaterialLinks(malformed + raw, 'term'), [
    { text: malformed }, { text: '提纲', resourceId: 'r', raw },
  ]);
});
