import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentUstcTermKey, loadUstcCalendar, parseUstcCalendar } from '../src/lib/ustc-calendar';
import { presetOfferingTitle } from '../src/lib/course-presets';

const source = 'https://www.teach.ustc.edu.cn/calendar/20135.html';

test('识别科大秋季跨年校历，使用上课日而非注册日', () => {
  const result = parseUstcCalendar('<p>一、秋季学期于 2026 年 8 月 30 日开学注册，8 月 31 日上课，2027 年 1 月 15 日学期结束，共计 20 教学周。</p>', source);
  assert.equal(result.length, 1);
  assert.equal(result[0].key, '2026-autumn');
  assert.equal(result[0].startsOn, '2026-08-31');
  assert.equal(result[0].endsOn, '2027-01-15');
});

test('春季只读取明确学期，夏季短学期不会成为实践Ⅱ', () => {
  const result = parseUstcCalendar('一、2026春季学期于2026年3月1日开学注册，3月2 日上课，7月3日学期结束，共计18教学周。二、夏季学期于7月6日开始，7月31日结束。', source);
  assert.deepEqual(result.map(term => [term.key, term.startsOn, term.endsOn]), [['2026-spring', '2026-03-02', '2026-07-03']]);
  assert.equal(presetOfferingTitle('practice', 'spring'), '设计创新实践Ⅱ');
  assert.equal(presetOfferingTitle('practice', 'autumn'), '设计创新实践Ⅰ');
  assert.equal(presetOfferingTitle('thinking', 'spring'), presetOfferingTitle('thinking', 'autumn'));
});

test('上海跨年一月仍选上一秋季，寒假后春季不选夏季', () => {
  assert.equal(currentUstcTermKey(new Date('2026-11-03T00:00:00Z')), '2026-autumn');
  assert.equal(currentUstcTermKey(new Date('2026-12-31T17:00:00Z')), '2026-autumn');
  assert.equal(currentUstcTermKey(new Date('2027-01-31T16:00:00Z')), '2027-spring');
  assert.equal(currentUstcTermKey(new Date('2027-08-01T00:00:00+08:00')), '2027-autumn');
});

test('不完整、非法日期与非官方来源不能生成可发布学期', () => {
  const complete = '春季学期于2026年3月1日开学注册，3月2日上课，7月3日学期结束';
  assert.deepEqual(parseUstcCalendar(complete, 'https://example.com/calendar/20135.html'), []);
  assert.deepEqual(parseUstcCalendar('下学期2027年2月21日开学注册，2月22日上课。', source), []);
  assert.deepEqual(parseUstcCalendar(complete.replace('7月3日', '6月31日'), source), []);
  assert.deepEqual(parseUstcCalendar(complete.replace('7月3日', '3月3日'), source), []);
});

test('离线快照包含已核实春秋日期，不猜测未公布的2027春结束日期', async () => {
  const terms = await loadUstcCalendar();
  assert.equal(terms.find(term => term.key === '2026-autumn')?.endsOn, '2027-01-15');
  assert.equal(terms.find(term => term.key === '2026-spring')?.endsOn, '2026-07-03');
  assert.equal(terms.some(term => term.key === '2027-spring'), false);
});
