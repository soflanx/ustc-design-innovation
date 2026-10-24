import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTeachingDateInput, toTeachingDateInput } from '../src/lib/teaching-format';

test('截止时间按北京时间解析，拒绝日期滚动、缺失时区含义及非法小时', () => {
  assert.equal(parseTeachingDateInput('2030-10-20T23:59')?.toISOString(), '2030-10-20T15:59:00.000Z');
  assert.equal(toTeachingDateInput(new Date('2030-10-20T16:00:00Z')), '2030-10-21T00:00');
  assert.equal(parseTeachingDateInput(''), null);
  for (const value of ['2030-02-30T12:00', '2030-10-20T24:01', '2030-10-20', '2030-10-20T23:59Z']) {
    assert.throws(() => parseTeachingDateInput(value));
  }
});
