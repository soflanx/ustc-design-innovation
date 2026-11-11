import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasGroupDraftChanges, startGroupEdit } from '../src/lib/group-page-draft';

const first = { title: '第一次访谈', body: '三位新生都停在食堂入口。', revision: 1, updatedAt: null };
const second = { title: '第二次观察', body: '两位新生在路口看了指示牌。', revision: 2, updatedAt: null };

test('另一成员已保存第 2 版时，显式恢复第 1 版仍是一份待核对的草稿', () => {
  const restored = { ...startGroupEdit(first), conflict: second, restoredRevision: first.revision };
  assert.equal(hasGroupDraftChanges(restored), true);
  assert.equal(restored.checkedRevision, null);
  assert.equal(hasGroupDraftChanges({ ...restored, checkedRevision: second.revision }), true);
  assert.deepEqual(restored.baseline, first);
});

test('普通编辑改回原文后没有未保存的草稿，即使已看到另一成员的更新', () => {
  const original = startGroupEdit(first);
  assert.equal(hasGroupDraftChanges(original), false);
  const writing = { ...original, body: '补访第四位学生。', conflict: second };
  assert.equal(hasGroupDraftChanges(writing), true);
  assert.equal(hasGroupDraftChanges({ ...writing, body: first.body }), false);
});
