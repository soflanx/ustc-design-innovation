import assert from 'node:assert/strict';
import { test } from 'node:test';
import { showcaseWorkspaceHref } from '../src/lib/group-showcase-contract';
import { courseLessonHref, groupWorkHref, parseGroupSource, parseLessonRecordOrigin } from '../src/lib/group-work-link';

test('共享小组入口指向目录，已选定小组和活动的入口保留各自语义', () => {
  assert.equal(groupWorkHref('offering'), '/courses/offering/groups');
  assert.equal(groupWorkHref('offering', 'lesson-2'), '/courses/offering/groups?fromPage=lesson-2');
  const url = new URL(groupWorkHref('offering', '访谈-2', 'group-1'), 'https://example.invalid');
  assert.equal(url.pathname, '/courses/offering/groups/group-1');
  assert.equal(url.searchParams.get('fromPage'), '访谈-2');
});

test('活动来源只接受单个页面标识', () => {
  for (const value of [undefined, null, ['lesson'], '.', '..', '', 'a'.repeat(201), '//outside.invalid', 'a/b', '%2e%2e', 'x?next=y', 'line\nbreak']) {
    assert.equal(parseGroupSource(value), undefined);
  }
  assert.equal(groupWorkHref('offering', 'https://outside.invalid'), '/courses/offering/groups');
});

test('由课次记录打开小组和展示时保留已撤回筛选', () => {
  const records = parseLessonRecordOrigin({ fromLessonRecords: '1', fromLessonRecordsWithdrawn: '1' });
  const group = groupWorkHref('offering', 'lesson-2', 'group-1', records);
  assert.equal(group, '/courses/offering/groups/group-1?fromPage=lesson-2&fromLessonRecords=1&fromLessonRecordsWithdrawn=1');
  assert.equal(courseLessonHref('offering', 'lesson-2', records), '/courses/offering/pages/lesson-2?view=records&includeWithdrawn=1');
  const preview = showcaseWorkspaceHref('offering', 'group-1', new URL(group, 'https://example.invalid').searchParams, true);
  assert.equal(preview, `${group.replace('?', '/showcase?')}&view=preview`);
  assert.equal(groupWorkHref('offering', 'lesson-2', undefined, parseLessonRecordOrigin({ fromLessonRecordsWithdrawn: '1' })),
    '/courses/offering/groups?fromPage=lesson-2');
  assert.equal(groupWorkHref('offering', '//external.invalid', 'group-1', records), '/courses/offering/groups/group-1');
});
