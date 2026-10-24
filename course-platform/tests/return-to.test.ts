import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RETURN_TO, loginPath, normalizeReturnTo } from '../src/lib/return-to';

test('登录回跳保留站内页面、查询与显式锚点，不改变课程授权', () => {
  for (const target of [
    '/', '/workspace', '/workspace?view=all',
    '/courses/offering-a/assignments/task-a?view=pending&scope=mine#version-123',
    '/courses/offering-a/resources?q=%E8%AE%BF%E8%B0%88%20%E8%AE%B0%E5%BD%95',
    '/courses/offering-a/resources?q=100%25',
    '/manage/courses/course-thinking/new-offering',
  ]) assert.equal(normalizeReturnTo(target), target);
  const unicode = new URL(normalizeReturnTo('/courses/课程/resources?q=访谈#资料'), 'https://example.invalid');
  assert.equal(unicode.searchParams.get('q'), '访谈');
  assert.equal(decodeURIComponent(unicode.hash), '#资料');
});

test('无来源或非字符串参数沿用我的课程；登录链接仅携带安全目标', () => {
  for (const value of [undefined, null, '', [], ['/courses/a', '//evil.invalid'], 42, {}]) {
    assert.equal(normalizeReturnTo(value), DEFAULT_RETURN_TO);
    assert.equal(loginPath(value), '/login');
  }
  const target = '/courses/a/assignments/b?view=pending&scope=mine#version-123';
  const login = new URL(loginPath(target), 'https://example.invalid');
  assert.equal(login.pathname, '/login');
  assert.equal(login.searchParams.get('returnTo'), target);
  assert.equal(login.hash, '');
  assert.equal(loginPath('/workspace'), '/login');
});

test('回跳拒绝外站、协议相对、反斜杠、控制符及多重编码绕过', () => {
  const unsafe = [
    'https://evil.invalid/courses/a', 'https://return-to.invalid/courses/a', 'javascript:alert(1)',
    '//evil.invalid', '///evil.invalid', '/\\evil.invalid', '\\evil.invalid',
    '/%2fevil.invalid', '/%252fevil.invalid', '/%25%32%66evil.invalid', '/%5cevil.invalid', '/%255cevil.invalid',
    '/courses/..//evil.invalid', '/courses%2flogin', '/courses%3fnext=evil', '/courses%23login',
    ' /courses/a', '/courses/a ', '/courses/a\n', '/courses/\tadmin', '/courses/a\u0000',
    '/courses/a?q=%0d%0aLocation:evil', '/courses/a?q=%250d', '/courses/a#%255c',
    '/courses/a?q=%C2%85', '/courses/a?q=%25C2%2585', '/courses/a#%E2%80%A8',
    '/courses/%E0%A4%A', '/courses/a?q=%', '/courses/a?q=%E0%A4%A',
    `/${'%25'.repeat(8)}2f`, '/courses/a?q=%252525252525250a',
  ];
  for (const target of unsafe) assert.equal(normalizeReturnTo(target), DEFAULT_RETURN_TO, target);
});

test('回跳拒绝登录、退出、API及其编码/路径规范化变体', () => {
  for (const target of [
    '/login', '/login?returnTo=/courses/a', '/login/', '/LOGIN', '/logout#again',
    '/api/demo-login', '/api/logout', '/_next/static/chunk.js',
    '/courses/../login', '/courses/%2e%2e/api/logout', '/courses/%252e%252e/login',
    '/%6cogin', '/%256cogin', '/%61pi/logout', '/%2561pi/demo-login',
  ]) {
    assert.equal(normalizeReturnTo(target), DEFAULT_RETURN_TO, target);
    assert.equal(loginPath(target), '/login', target);
  }
});
