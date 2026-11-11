import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireEditorAuthor } from '../src/lib/action-utils';

test('编辑器写入拒绝更换账号，同时允许原账号和旧调用', () => {
  assert.throws(() => requireEditorAuthor('other-teacher', 'opening-teacher'), /登录账号已切换/);
  assert.doesNotThrow(() => requireEditorAuthor('opening-teacher', 'opening-teacher'));
  assert.doesNotThrow(() => requireEditorAuthor('legacy-teacher', undefined));
});
