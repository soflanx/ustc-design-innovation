import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSubmissionBodies, previousSubmissionVersions } from '../src/lib/submission-comparison';

test('只找同一份提交可读的直接上一版，兼容乱序、换提交人、相同署名和缺失版本', () => {
  const first = { id: 'a1', submissionId: 'a', version: 1, submittedBy: '甲' };
  const second = { id: 'a2', submissionId: 'a', version: 2, submittedBy: '乙' };
  const other = { id: 'b1', submissionId: 'b', version: 1, submittedBy: '乙' };
  const missing = { id: 'a4', submissionId: 'a', version: 4, submittedBy: '乙' };
  const joinedLater = { id: 'c2', submissionId: 'c', version: 2, submittedBy: '乙' };
  const result = previousSubmissionVersions([second, other, missing, joinedLater, first]);
  assert.deepEqual([...result], [[second.id, first]]);
});

test('分开对照两处修改，完整保留对应句段的缩进、标点、CRLF 和空行', () => {
  const previous = '看见什么？\r\n  他走开了。\r\n\r\n第二次观察。\n等了两秒！\n结尾。';
  const current = '看见什么？\r\n  他后退两步。\r\n\r\n第二次观察。\n等了五秒！\n结尾。';
  assert.deepEqual(compareSubmissionBodies(previous, current), { mode: 'passages', passages: [
    { previous: '  他走开了。\r\n\r\n', current: '  他后退两步。\r\n\r\n' },
    { previous: '等了两秒！\n', current: '等了五秒！\n' },
  ] });
});

test('相同正文、新增、删除和仅换行的改动分别有精确结果', () => {
  assert.deepEqual(compareSubmissionBodies('第一句。\n', '第一句。\n'), { mode: 'identical', passages: [] });
  assert.deepEqual(compareSubmissionBodies('甲。乙。', '甲。新。乙。').passages, [{ previous: '', current: '新。' }]);
  assert.deepEqual(compareSubmissionBodies('甲。乙。乙。', '甲。乙。').passages, [{ previous: '乙。', current: '' }]);
  assert.deepEqual(compareSubmissionBodies('\r\n\r\n', '\n\n'), { mode: 'identical', passages: [] });
  assert.deepEqual(compareSubmissionBodies('甲。\r\r乙。', '甲。\n\n乙。'), { mode: 'identical', passages: [] });
  assert.deepEqual(compareSubmissionBodies('甲。\r\n\r\n乙。', '甲。\n乙。').passages, [{ previous: '甲。\r\n\r\n', current: '甲。\n' }]);
});

test('旧稿 LF 经表单变为 CRLF，仅对照第二段真正改过的句子并保留两版各自的换行', () => {
  const previous = '第一次观察。记录人流。\n\n他停顿两秒。\n再访。';
  const current = '第一次观察。记录人流。\r\n\r\n他停顿五秒。\r\n再访。';
  assert.deepEqual(compareSubmissionBodies(previous, current), { mode: 'passages', passages: [
    { previous: '他停顿两秒。\n', current: '他停顿五秒。\r\n' },
  ] });
});

test('替换原型网址保留整句与完整链接，不从域名、查询、片段中的标点断开', () => {
  const original = 'https://design.example.test/proto/v1.2?screen=2.3&view=demo#step-1';
  const revised = 'https://design.example.test/proto/v1.2?screen=2.4&view=demo#step-2';
  const before = `🚀 请测试 ${original}。\n`;
  const after = `🚀 请测试 ${revised}。\r\n`;
  assert.deepEqual(compareSubmissionBodies('背景不变。' + before + '再记录反应。', '背景不变。' + after + '再记录反应。'), {
    mode: 'passages', passages: [{ previous: before, current: after }],
  });
});

test('一份提交有多个原型，新增或移除的句子保留自己的网址', () => {
  const first = 'https://prototype.example.test/a?rev=1';
  const second = 'https://prototype.example.test/b?rev=2';
  const intro = `先打开 ${first}。`;
  const extra = `再试 ${second}。`;
  assert.deepEqual(compareSubmissionBodies(intro, intro + extra).passages, [{ previous: '', current: extra }]);
  assert.deepEqual(compareSubmissionBodies(intro + extra, intro).passages, [{ previous: extra, current: '' }]);
  const joint = `依次打开 ${first} 和 ${second}。`;
  const reversed = `依次打开 ${second} 和 ${first}。`;
  assert.deepEqual(compareSubmissionBodies(joint, reversed).passages, [{ previous: joint, current: reversed }]);
});

test('含大量伪网址和括号的 12000 字正文仍能对照末尾的完整网址', () => {
  const previous = '原型 https://example.test/demo?page=1。';
  const current = '原型 https://example.test/demo?page=2。';
  const noisy = 'https://%GG.?! (javascript:bad) '.repeat(500).slice(0, 12000 - previous.length - 1) + '\n';
  assert.equal((noisy + previous).length, 12000);
  assert.deepEqual(compareSubmissionBodies(noisy + previous, noisy + current).passages, [{ previous, current }]);
});

test('重复句与移动文本不借用别处的版本或改写原句', () => {
  const result = compareSubmissionBodies('开始。A。再看。B。再看。C。', '开始。a。再看。B。再看。c。');
  assert.deepEqual(result.passages, [{ previous: 'A。', current: 'a。' }, { previous: 'C。', current: 'c。' }]);
  assert.deepEqual(compareSubmissionBodies('甲。乙。', '乙。甲。').passages, [{ previous: '甲。', current: '' }, { previous: '', current: '甲。' }]);
});

test('12000 字密集短句限制对齐规模，回退保留两侧完整原文及相同的中间句', () => {
  const previous = '甲。'.repeat(2999) + '同。' + '乙。'.repeat(3000);
  const current = '丙。'.repeat(2999) + '同。' + '丁。'.repeat(3000);
  assert.equal(previous.length, 12000);
  assert.deepEqual(compareSubmissionBodies(previous, current), { mode: 'range', passages: [{ previous, current }] });
  const unbroken = '🍃'.repeat(6000);
  assert.deepEqual(compareSubmissionBodies(unbroken, '无换行。').passages, [{ previous: unbroken, current: '无换行。' }]);
});
