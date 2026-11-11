import { test } from 'node:test';
import assert from 'node:assert/strict';
import { courseLabel, offeringCourseTitle } from '../src/lib/course-label';

const practice = { slug: 'design-practice', title: '设计创新实践' };
const thinking = { slug: 'design-thinking', title: '设计创新思维' };
const offering = (name: string, title = '设计创新实践') => ({ course: practice, title, term: { name } });

test('实践课按秋季Ⅰ、春季Ⅱ显示同一期的全名和短名', () => {
  assert.equal(offeringCourseTitle(offering('2026 年秋季学期')), '设计创新实践Ⅰ');
  assert.equal(courseLabel(practice, '2026 年秋季学期'), '实践Ⅰ · 2026秋');
  assert.equal(offeringCourseTitle(offering('2027 年春季学期')), '设计创新实践Ⅱ');
  assert.equal(courseLabel(practice, '2027 年春季学期'), '实践Ⅱ · 2027春');
});

test('已保存的实践Ⅰ、Ⅱ或1、2优先于后来改动的学期名称', () => {
  for (const title of ['设计创新实践Ⅰ · 2026秋', '设计创新实践 1 · 2026秋', '设计创新实践（I）']) {
    assert.equal(offeringCourseTitle(offering('2027春', title)), '设计创新实践Ⅰ');
    assert.equal(courseLabel(practice, '2027春', title), '实践Ⅰ · 2027春');
  }
  for (const title of ['设计创新实践Ⅱ · 2027春', '设计创新实践 2 · 2027春', '设计创新实践（II）']) {
    assert.equal(offeringCourseTitle(offering('2026秋', title)), '设计创新实践Ⅱ');
    assert.equal(courseLabel(practice, '2026秋', title), '实践Ⅱ · 2026秋');
  }
});

test('年份或日期中的1、2不被误识别为课程序号，未确认的季节不自动编号', () => {
  assert.equal(offeringCourseTitle(offering('2026 年秋季学期', '设计创新实践 · 2026年')), '设计创新实践Ⅰ');
  assert.equal(courseLabel(practice, '2026 夏季学期', '设计创新实践 · 2026/1/2'), '实践 · 2026夏');
  assert.equal(offeringCourseTitle(offering('2026 夏季学期')), '设计创新实践');
});

test('思维课名称不随学期或误传的实践序号改变', () => {
  assert.equal(courseLabel(thinking, '2027 春季学期', '实践Ⅱ'), '思维 · 2027春');
  assert.equal(offeringCourseTitle({ course: thinking, title: '实践Ⅱ', term: { name: '2027春' } }), '设计创新思维');
});

test('未识别的历史课程保留真实课程标题，不套用实践规则', () => {
  const other = { slug: 'legacy-course', title: '历史课程 · 设计实践' };
  assert.equal(courseLabel(other, '2027 春季学期', '设计创新实践Ⅰ'), '历史课程 · 设计实践 · 2027春');
  assert.equal(offeringCourseTitle({ course: other, title: '设计创新实践Ⅰ', term: { name: '2027春' } }), other.title);
  assert.equal(courseLabel(other, '跨年工作坊'), '历史课程 · 设计实践 · 跨年工作坊');
});
