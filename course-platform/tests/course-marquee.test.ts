import assert from 'node:assert/strict';
import test from 'node:test';
import { marqueeBlockRange, marqueeRectangle, marqueeScrollDelta, type Rect } from '../src/lib/course-marquee';

const block = (id: string, top: number, bottom: number, left = 100, right = 500) => ({ id, left, top, right, bottom });
const blocks = [block('title', 20, 60), block('paragraph', 80, 120), block('record', 140, 240), block('after', 260, 300)];

test('从四个方向框选得到相同的连续块范围', () => {
  const expected: Rect = { left: 50, top: 90, right: 180, bottom: 180 };
  for (const [start, end] of [
    [{ x: 50, y: 90 }, { x: 180, y: 180 }],
    [{ x: 180, y: 180 }, { x: 50, y: 90 }],
    [{ x: 180, y: 90 }, { x: 50, y: 180 }],
    [{ x: 50, y: 180 }, { x: 180, y: 90 }],
  ]) {
    const rect = marqueeRectangle(start, end);
    assert.deepEqual(rect, expected);
    assert.deepEqual(marqueeBlockRange(rect, blocks), ['paragraph', 'record']);
  }
});

test('框与块必须有正面积相交，点击、边缘接触和纯空白都不选择', () => {
  for (const rect of [
    { left: 150, right: 150, top: 30, bottom: 200 },
    { left: 150, right: 300, top: 90, bottom: 90 },
    { left: 50, right: 100, top: 0, bottom: 400 },
    { left: 500, right: 550, top: 0, bottom: 400 },
    { left: 100, right: 500, top: 60, bottom: 80 },
    { left: 100, right: 500, top: 301, bottom: 400 },
  ]) assert.deepEqual(marqueeBlockRange(rect, blocks), []);
  assert.deepEqual(marqueeBlockRange({ left: 0, top: 0, right: 800, bottom: 400 }, []), []);
});

test('局部交叉、完整包含以及跨越父块子树的框都选择完整根块', () => {
  assert.deepEqual(marqueeBlockRange({ left: 499, right: 501, top: 119, bottom: 121 }, blocks), ['paragraph']);
  assert.deepEqual(marqueeBlockRange({ left: 0, right: 600, top: 0, bottom: 400 }, blocks), ['title', 'paragraph', 'record', 'after']);
  const parentWithChildren = [block('parent', 0, 240), block('next', 260, 300)];
  assert.deepEqual(marqueeBlockRange({ left: 150, right: 200, top: 180, bottom: 220 }, parentWithChildren), ['parent']);
});

test('首末命中之间的块保持文档顺序，不因缩进空隙产生不连续选区', () => {
  const offsetBlocks = [block('first', 0, 40), block('indented', 50, 90, 250), block('last', 100, 140)];
  const before = structuredClone(offsetBlocks);
  offsetBlocks.forEach(Object.freeze); Object.freeze(offsetBlocks);
  assert.deepEqual(marqueeBlockRange({ left: 90, right: 150, top: 20, bottom: 120 }, offsetBlocks), ['first', 'indented', 'last']);
  assert.deepEqual(offsetBlocks, before);
});

test('空尺寸或无效布局不会产生选区', () => {
  assert.deepEqual(marqueeBlockRange({ left: 0, right: Number.NaN, top: 0, bottom: 300 }, blocks), []);
  assert.deepEqual(marqueeBlockRange({ left: 200, right: 100, top: 0, bottom: 300 }, blocks), []);
  assert.deepEqual(marqueeBlockRange({ left: 0, right: 500, top: 0, bottom: 300 }, [block('hidden', 100, 100)]), []);
});

test('框选自动滚动在56像素边缘区线性加速，越界保持每帧18像素上限', () => {
  for (const y of [156, 300, 400, 644]) assert.equal(marqueeScrollDelta(y, 100, 700), 0);
  assert.equal(marqueeScrollDelta(128, 100, 700), -9);
  assert.equal(marqueeScrollDelta(672, 100, 700), 9);
  assert.ok(Math.abs(marqueeScrollDelta(155, 100, 700) + 18 / 56) < 1e-10);
  assert.ok(Math.abs(marqueeScrollDelta(645, 100, 700) - 18 / 56) < 1e-10);
  for (const y of [100, 80, -1000]) assert.equal(marqueeScrollDelta(y, 100, 700), -18);
  for (const y of [700, 720, 2000]) assert.equal(marqueeScrollDelta(y, 100, 700), 18);
});

test('窄小或无效视口保留中性区域，不出现反向或无限滚动', () => {
  assert.equal(marqueeScrollDelta(30, 0, 60), 0);
  assert.equal(marqueeScrollDelta(15, 0, 60), -9);
  assert.equal(marqueeScrollDelta(45, 0, 60), 9);
  assert.equal(marqueeScrollDelta(100, 100, 100), 0);
  assert.equal(marqueeScrollDelta(100, 200, 100), 0);
  assert.equal(marqueeScrollDelta(Number.NaN, 0, 700), 0);
});
