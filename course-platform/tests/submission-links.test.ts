import assert from 'node:assert/strict';
import { test } from 'node:test';
import { submissionTextParts } from '../src/lib/submission-links';

function links(source: string) {
  const parts = submissionTextParts(source);
  assert.equal(parts.map(part => part.text).join(''), source);
  for (const part of parts) if (part.href) assert.equal(part.text, part.href);
  return parts.flatMap(part => part.href ? [part.href] : []);
}

test('原型网址与提交原文逐字一致，中文标点、空行、缩进仍属于原文', () => {
  const url = 'HTTPS://例子.中国/导视/屏幕(v2)?node-id=4%3A2&tab=play#路线';
  const source = `第一步：看原型（${url}）。\r\n\r\n  第二步，说明变化。`;
  assert.deepEqual(submissionTextParts(source), [
    { text: '第一步：看原型（' }, { text: url, href: url }, { text: '）。\r\n\r\n  第二步，说明变化。' },
  ]);
  assert.deepEqual(links(`也可看${url}，再返回。`), [url]);
  assert.deepEqual(links('请访问:HTTP://x.test/a'), ['HTTP://x.test/a']);
  assert.deepEqual(links(`见《${url}》；点“${url}”！`), [url, url]);
});

test('相邻版本各自可点，配对括号、IPv6、端口和查询中的完整转跳仍属于地址', () => {
  const a = 'http://[::1]:4193/demo(a(b))?slides[]=3#v1';
  const b = 'https://test.example/v2?continue=https://example.org/walk&metric=2.5';
  for (const separator of ['\r\n', '\t', '，', '。', '；', ',', ';', ' ']) {
    assert.deepEqual(links(`(${a})${separator}${b}.`), [a, b], separator);
    assert.deepEqual(links(`${a}${separator}${b}...`), [a, b], separator);
  }
  assert.deepEqual(links(`See <${a}> and "${b}".`), [a, b]);
});

test('原稿中的标签与 Markdown 记号均保留，裸域名、邮件与相对路径不是原型链接', () => {
  for (const source of ['', '只含文字。\r\n  没有网址！', 'www.example.org path/a //proto.example.org/ demo.example.org',
    'a@example.com  mailto:a@example.com  data:text/plain,hello  javascript:alert(1)']) {
    assert.deepEqual(submissionTextParts(source), [{ text: source }]);
  }
  const url = 'https://prototype.example/1';
  assert.deepEqual(submissionTextParts(`![假图](${url}) **正文**`), [
    { text: '![假图](' }, { text: url, href: url }, { text: ') **正文**' },
  ]);
  assert.deepEqual(links(`<b>原型</b>：${url}`), [url]);
});

test('拒绝畸形、带凭据和超长的整段地址，不从错误候选或其他协议中另取片段', () => {
  for (const candidate of [
    'https:///route', 'http:////example.com', 'https://?view=1', 'https://#screen', 'https://:80',
    'https://user:secret@example.org/a', 'https://@example.org/a', 'https://example.org:65536/proto',
    'https://[::1/a', 'https://example..org/a', 'https://example.org/path%Z',
    'https://example.org/path\\new', 'https://example.org/\u0000https://next.example/',
    'https://example.org/\u000bpart', 'https://example.org/\u202Eevil', 'https://example.org/\u2066spoof',
    'javascript:https://example.org/a', 'nothttps://example.org/', 'ftp://host/path?next=https://example.org',
    'https://user:secret@bad.example/path?to=https://good.example/', `https://long.example/${'a'.repeat(2050)}?to=https://good.example/`,
  ]) assert.deepEqual(links(candidate), [], JSON.stringify(candidate));
  const maximal = 'https://a.example/'.padEnd(2048, 'a');
  assert.deepEqual(links(maximal), [maximal]);
  assert.deepEqual(links(maximal + 'a'), []);
});
