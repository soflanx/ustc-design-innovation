import 'dotenv/config';
import assert from 'node:assert/strict';

const origin = new URL(process.env.APP_URL || 'http://127.0.0.1:4174').origin;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('只可检查本机演示服务器。');
const course = '/courses/offering-thinking-2026-autumn';
const archivedCourse = '/courses/offering-thinking-2025-autumn';
const teachingItems = [
  { section: 'resources', id: 'demo-resource-observation' },
  { section: 'assignments', id: 'demo-assignment-observation', mode: '个人作业' },
  { section: 'assignments', id: 'demo-assignment-prototype', mode: '小组作业' },
];
const groupNames = { a: '第一组 · 观察者', b: '第二组 · 探索者' };
const sessions = new Set();
const skipped = [];
const get = (path, cookie) => fetch(`${origin}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

async function login(requestOrigin, userId, returnTo) {
  const body = new URLSearchParams({ userId });
  for (const target of Array.isArray(returnTo) ? returnTo : returnTo === undefined ? [] : [returnTo]) body.append('returnTo', target);
  const response = await fetch(`${origin}/api/demo-login`, {
    method: 'POST', redirect: 'manual',
    headers: { origin: requestOrigin, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  // Track every issued session before assertions, including unexpected login success.
  const cookie = response.headers.get('set-cookie')?.match(/design-course-session=[^;,\s]+/)?.[0];
  if (cookie) sessions.add(cookie);
  return response;
}

async function loginAs(userId) {
  const response = await login(origin, userId);
  assert.equal(response.status, 303, `${userId}：需运行 npm run dev 并启用本机演示登录`);
  const header = response.headers.get('set-cookie');
  assert.match(header ?? '', /HttpOnly/i);
  assert.match(header ?? '', /SameSite=lax/i);
  const cookie = header?.match(/design-course-session=[^;,\s]+/)?.[0];
  assert.ok(cookie, `${userId} 应获得会话 cookie`);
  return cookie;
}

async function page(path, cookie) {
  const response = await get(path, cookie);
  assert.equal(response.status, 200, `${path} 应可访问`);
  return response.text();
}

function assertRedirect(response, target, message, status = 307) {
  assert.equal(response.status, status, message);
  const location = response.headers.get('location');
  assert.ok(location, '重定向应包含目标地址');
  const destination = new URL(location, origin);
  assert.equal(destination.origin, origin);
  assert.equal(destination.pathname + destination.search + destination.hash, target, message);
}

const escapeAttribute = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&#x27;');
const hasLink = (html, path) => html.includes(`href="${escapeAttribute(path)}"`);
const decodeHtml = value => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');
// Keep element boundaries: the brand “设计创新” beside “思维 · 2026秋”
// is two labels, not a rendered “设计创新思维” course heading.
const textContent = html => decodeHtml(html
  .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
assert.equal(textContent('<a>设计创新</a><span title="设计创新思维 · 2026 年秋季学期">思维 · 2026秋</span>'), '设计创新 思维 · 2026秋');
assert.ok(textContent('<header><span>设计创新思维 · 2026 年秋季学期</span></header>').includes('设计创新思维 · '), '可见的完整课程定位仍必须命中重复定位检查');
assert.equal(textContent('<span>思维 · 2026秋</span><script>"设计创新思维 · 2026 年秋季学期"</script>'), '思维 · 2026秋');
function linksIn(html) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].flatMap(([, attributes, body]) => {
    const href = attributes.match(/\bhref="([^"]*)"/)?.[1];
    return href === undefined ? [] : [{ href: decodeHtml(href), text: textContent(body), attributes }];
  });
}
const loginTarget = returnTo => returnTo === '/workspace' ? '/login' : `/login?${new URLSearchParams({ returnTo })}`;
function offeringCards(html) {
  return [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)].flatMap(([, body]) => {
    const path = body.match(/href="(\/courses\/[^"/?#]+)"/)?.[1];
    const status = body.includes('已归档') ? 'ARCHIVED' : body.includes('筹备中') ? 'DRAFT' : body.includes('进行中') ? 'ACTIVE' : null;
    return path && status ? [{ path, status }] : [];
  });
}

function assertCourseSelection(html) {
  assert.ok(!html.includes('data-course-task='), '课程选择页不应把任务预览变成绕过当前教学的入口');
  for (const [, body] of html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)) {
    const links = linksIn(body);
    if (!links.some(link => /^\/courses\/[^/?#]+$/.test(link.href))) continue;
    assert.equal(links.length, 1, '每张课程卡只应有一个进入课程的目的地');
    assert.match(links[0].href, /^\/courses\/[^/?#]+$/, '选择课程应先进入当前教学，不应直达管理或作业');
  }
  assert.ok(!linksIn(html).some(link => /^\/courses\/[^/?#]+\/manage(?:[?#]|$)/.test(link.href)), '课程管理入口应保留在课程内');
}

async function checkCourseSelection(cookie, userId) {
  const html = await page('/workspace?view=all', cookie);
  assertCourseSelection(html);
  const cards = offeringCards(html);
  assert.deepEqual(cards.filter(card => card.status === 'ACTIVE').map(card => card.path), [course], `${userId} 应有一个进行中的演示课程`);
  assert.ok(cards.some(card => card.status === 'ARCHIVED'), '课程选择页应保留往期课程');
  assertRedirect(await get('/workspace', cookie), course, '一个 ACTIVE 课程应直接进入，筹备课不能阻止跳转');
  return cards;
}

function assertReviewView(html, view, scope) {
  assert.ok(html.includes('aria-label="提交概况"'), '教学团队应能读取提交概况');
  assert.ok(html.includes(`data-review-view="${view}"`), `应呈现 ${view} 视图`);
  assert.ok(html.includes(`data-review-scope="${scope}"`), `应呈现 ${scope} 范围`);
}

const submissionOwners = html => new Set([...html.matchAll(/data-submission-owner="([^"]+)"/g)].map(([, id]) => id));

function assertStudentProgress(html) {
  assert.ok(html.includes('aria-label="当前作业进度"'));
  assert.ok(/<section\b[^>]*\bid="submission"[^>]*\baria-label="当前作业进度"/.test(html), '提交操作应有可定位的学生提交区');
  const state = html.match(/data-assignment-progress="([^"]+)"/)?.[1];
  assert.ok(['UNGROUPED', 'NOT_SUBMITTED', 'SUBMITTED', 'FEEDBACK_AVAILABLE'].includes(state), '学生进度应使用实际归属与可见版本计算');
  assert.ok(!html.includes('aria-label="提交概况"'), '学生不可获得教学团队概况面板');
  assert.ok(!html.includes('data-submission-owner="'), '学生不可获得全班提交归属名单');
}

function assertCourseFrame(html, active, role, basePath = course) {
  assert.equal([...html.matchAll(/data-course-frame="([^"]+)"/g)].length, 1, '课程内各页应使用一个统一课程框架');
  assert.ok(html.includes(`data-course-frame="${active}"`), `课程框架应标识 ${active} 位置`);
  const header = html.match(/<header\b[^>]*\bclass="[^"]*\bsite-header\b[^"]*"[^>]*>([\s\S]*?)<\/header>/)?.[1];
  assert.ok(header, '课程框架应保留站点页头');
  const identity = header.match(/<span\b[^>]*\bclass="[^"]*\bheader-course\b[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1];
  assert.ok(identity, '页头应使用普通文字呈现简短课程标识');
  assert.ok(!linksIn(header).some(link => link.text.includes(textContent(identity))), '课程标识不能成为含义不清的跳转入口');
  assert.ok(!/<a\b/.test(identity), '课程标识不能包含链接');
  if (basePath === course) assert.equal(textContent(identity), '思维 · 2026秋');
  if (basePath === archivedCourse) assert.equal(textContent(identity), '思维 · 2025秋');
  const selectionLinks = linksIn(html).filter(link => link.href === '/workspace?view=all');
  assert.equal(selectionLinks.length, 1, '全部课程应为课程内唯一的课程选择入口');
  assert.equal(selectionLinks[0].text, '全部课程');
  assert.ok(linksIn(header).some(link => link.href === '/' && link.text === '设计创新'), '品牌应明确返回公开首页');
  assert.ok(!textContent(header).includes('切换课程'), '课程页头不应重复提供切换课程入口');
  const positions = [...html.matchAll(/<header\b[^>]*>([\s\S]*?)<\/header>/g)].map(([, body]) => textContent(body));
  const breadcrumbs = linksIn(html).filter(link => /\bclass="[^"]*\bbreadcrumb\b/.test(link.attributes));
  assert.ok([...positions, ...breadcrumbs.map(link => link.text)].every(text => !text.includes('设计创新思维 · ')), '页头与返回路径不应重复铺开完整课程定位');
  const labels = { overview: '当前教学', assignments: '作业与反馈', resources: '课程资料', groups: role === 'STUDENT' ? '我的小组' : '小组', team: '教学团队', manage: '课程管理' };
  assert.ok(linksIn(html).some(link => link.text === labels[active] && /\baria-current="page"/.test(link.attributes)), '统一课程导航应指明当前位置');
  assert.equal(hasLink(html, `${basePath}/manage`), role === 'TEACHER' || role === 'ADMIN', '统一导航应保留课程管理权限边界');
}

let submissionTargetChecks = 0;
function assertSubmissionTargets(html) {
  for (const link of linksIn(html).filter(link => link.text.startsWith('去提交作业'))) {
    const target = new URL(link.href, origin);
    assert.equal(target.origin, origin);
    assert.ok(target.pathname.startsWith(`${course}/assignments/`), '提交按钮应指向具体作业');
    assert.equal(target.hash, '#submission', '去提交作业应直接定位学生提交区');
    submissionTargetChecks++;
  }
}

const assignmentEditPath = id => `${course}/assignments?edit=${encodeURIComponent(id)}#edit-${encodeURIComponent(id)}`;
function assertAssignmentEditor(html, id, canManage) {
  const editor = [...html.matchAll(/<details\b([^>]*)>/g)].find(([, attributes]) => attributes.includes(`id="edit-${id}"`));
  assert.equal(!!editor, canManage, 'edit 查询不能扩大作业编辑权限');
  if (editor) assert.match(editor[1], /(?:^|\s)open(?:\s|=|$)/, '编辑深链应展开目标作业的编辑器');
}

function assertCurrentTeaching(html, role, basePath = course, archived = false) {
  assertCourseFrame(html, 'overview', role, basePath);
  assert.ok(html.includes(`data-workspace-role="${role}"`), '当前教学页应保留本期开课身份');
  assert.ok(!linksIn(html).some(link => link.text.includes('切换课程')), '当前教学不应重复呈现切换课程入口');
  assert.ok(html.includes('aria-label="当前教学内容"'), '第一主区应为教学团队维护的当前教学内容');
  const focus = html.match(/data-course-focus="([^"]+)"/)?.[1];
  assert.ok(['set', 'empty'].includes(focus), '教学内容应明确区分已填写与尚未填写');
  const canEdit = role !== 'STUDENT' && !archived;
  assert.equal(html.includes('aria-label="编辑当前教学内容"'), canEdit, '仅非归档期教师、助教或管理员可见当前教学编辑器');
  const canManage = role === 'TEACHER' || role === 'ADMIN';
  assert.equal(hasLink(html, `${basePath}/manage`), canManage, '当前教学编辑权不能扩大为课程管理权');
  for (const section of ['assignments', 'resources', 'team']) {
    assert.ok(hasLink(html, `${basePath}/${section}`), '不再预览的课程模块应保留导航入口');
  }
  if (role !== 'STUDENT') assert.ok(hasLink(html, `${basePath}/groups`), '教学团队应从导航进入全部小组');
  assert.ok(html.includes('>当前教学</a>'), '课程入口应使用当前教学导航语义');
  const tasks = [...html.matchAll(/data-current-task="([^"]+)"/g)];
  const scopes = [...html.matchAll(/data-assignment-scope="([^"]+)"/g)].map(([, scope]) => scope);
  assert.equal(scopes.length, tasks.length, '每个关联任务都应保留角色处理范围');
  for (const scope of scopes) assert.equal(scope, role === 'TA' ? 'mine' : role === 'STUDENT' ? 'self' : 'all');
  if (focus === 'empty') assert.equal(tasks.length, 0, '未填写教学内容时不能自动把全部作业当作本次关联任务');
  if (role === 'STUDENT') assertSubmissionTargets(html);
  if (!archived && (role === 'TEACHER' || role === 'ADMIN')) {
    for (const [, id] of tasks) {
      const row = [...html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/g)].find(([, attributes]) => attributes.includes(`data-current-task="${id}"`))?.[2] || '';
      for (const link of linksIn(row).filter(link => /管理作业/.test(link.text))) assert.equal(link.href, assignmentEditPath(id), '本次任务的管理操作应直接定位该作业编辑器');
    }
  }
  if (archived) assert.ok(html.includes('已归档') && html.includes('只读'), '归档状态仍应明确说明只读');
}

async function checkTeachingReads(cookie, role) {
  const canManage = role === 'TEACHER' || role === 'ADMIN';
  for (const section of ['resources', 'assignments']) {
    const html = await page(`${course}/${section}`, cookie);
    assertCourseFrame(html, section, role);
    if (role === 'STUDENT' && section === 'assignments') assertSubmissionTargets(html);
    for (const item of teachingItems.filter(item => item.section === section)) {
      assert.ok(hasLink(html, `${course}/${section}/${item.id}`), `已发布的 ${item.id} 应出现在本期资料目录`);
    }
  }
  for (const { section, id, mode } of teachingItems) {
    const html = await page(`${course}/${section}/${id}`, cookie);
    assertCourseFrame(html, section, role);
    if (mode) {
      assert.ok(html.includes(mode), `${id} 应显示正确的提交方式`);
      if (role === 'STUDENT') assertStudentProgress(html);
      else assertReviewView(html, 'latest', role === 'TA' ? 'mine' : 'all');
      assert.ok(linksIn(html).some(link => link.href === `${course}/assignments` && link.text === '← 作业与反馈'), '作业详情应提供简短明确的列表回链');
      assert.equal(hasLink(html, assignmentEditPath(id)), canManage, '作业详情应仅为教师或管理员提供直达本作业的编辑链接');
      const editorPage = await page(`${course}/assignments?${new URLSearchParams({ edit: id })}`, cookie);
      assertCourseFrame(editorPage, 'assignments', role);
      assertAssignmentEditor(editorPage, id, canManage);
      if (role === 'ADMIN') assert.ok(hasLink(editorPage, assignmentEditPath(id)), '管理员管理操作应直接定位该作业编辑器');
    } else {
      assert.ok(linksIn(html).some(link => link.href === `${course}/resources` && link.text === '← 课程资料'), '资料详情应提供简短明确的目录回链');
    }
    assert.equal((await get(`${archivedCourse}/${section}/${id}`, cookie)).status, 404, '不能通过改写学期路径读取另一学期的资料或作业');
  }
  for (const section of ['resources', 'assignments']) {
    assert.equal((await get(`${course}/${section}/nonexistent-http-check`, cookie)).status, 404, '不存在的教学记录应返回 404');
  }
  const searchQuery = `?${new URLSearchParams({ q: '受访者' })}`;
  const bodySearch = await page(`${course}/resources${searchQuery}`, cookie);
  assertCourseFrame(bodySearch, 'resources', role);
  const searchedResource = `${course}/resources/demo-resource-observation${searchQuery}`;
  assert.ok(hasLink(bodySearch, searchedResource), '搜索结果应匹配已授权正文并把搜索条件带入资料详情');
  const searchedDetail = await page(searchedResource, cookie);
  assertCourseFrame(searchedDetail, 'resources', role);
  assert.ok(linksIn(searchedDetail).some(link => link.href === `${course}/resources${searchQuery}` && link.text === '← 搜索结果'), '资料详情返回搜索结果时应保留原关键词');
  const noMatch = await page(`${course}/resources?q=HTTP-SEARCH-NO-MATCH-49de3c1f`, cookie);
  assert.ok(!linksIn(noMatch).some(link => new URL(link.href, origin).pathname === `${course}/resources/demo-resource-observation`), '无匹配搜索不应保留全部资料');
  assertCourseFrame(await page(`${course}/team`, cookie), 'team', role);
}

async function checkReviewFilters(cookie, role) {
  const path = `${course}/assignments/demo-assignment-prototype`;
  const defaultScope = role === 'TA' ? 'mine' : 'all';
  const perView = new Map();
  for (const view of ['latest', 'pending', 'missing']) {
    const html = await page(`${path}?view=${view}&scope=all`, cookie);
    assertReviewView(html, view, 'all');
    perView.set(view, submissionOwners(html));
    if (role === 'TA') {
      const mine = await page(`${path}?view=${view}&scope=mine`, cookie);
      assertReviewView(mine, view, 'mine');
      for (const id of submissionOwners(mine)) assert.equal(id, 'group-a', '助教负责组筛选不能混入未负责的 B 组');
    }
  }
  const latest = perView.get('latest');
  const missing = perView.get('missing');
  for (const id of latest) assert.ok(!missing.has(id), '同一归属不能同时出现在已交与未交列表');
  for (const id of perView.get('pending')) assert.ok(latest.has(id), '待反馈应只包含已交的最新版本');
  const currentOwners = new Set([...latest, ...missing]);
  for (const id of ['group-a', 'group-b']) assert.ok(currentOwners.has(id), '全期筛选应保留每个有有效成员的小组，无需假设提交数量');
  const history = await page(`${path}?view=history&scope=mine`, cookie);
  assertReviewView(history, 'history', 'all');
  const invalid = await page(`${path}?view=invalid-http-check&scope=group-b`, cookie);
  assertReviewView(invalid, 'latest', defaultScope);
}

async function checkGroupPage(cookie, role, groupId, basePath = course) {
  const html = await page(`${basePath}/groups/${groupId}`, cookie);
  assertCourseFrame(html, 'groups', role, basePath);
  if (role !== 'STUDENT') {
    assert.ok(linksIn(html).some(link => link.href === `${basePath}/groups` && link.text === '← 小组'), '教学团队查看小组记录后应有明确的目录回链');
  }
  return html;
}

let failure;
try {
  assert.equal((await get('/')).status, 200);
  assertRedirect(await get('/workspace'), '/login', '未登录应进入登录页');
  assert.equal((await login('https://untrusted.invalid', 'demo-student-a')).status, 403);
  assert.equal((await login(origin, 'unlisted-account')).status, 400);
  assertRedirect(await get('/workspace', 'design-course-session=' + '0'.repeat(64)), '/login', '伪造会话不可访问课程');
  for (const path of [
    `${course}/resources`, `${course}/assignments`,
    ...teachingItems.map(({ section, id }) => `${course}/${section}/${id}`),
  ]) {
    assertRedirect(await get(path), loginTarget(path), '匿名用户应先登录，并保留课程内资料或作业的原目标');
    assertRedirect(await get(path, 'design-course-session=' + '0'.repeat(64)), loginTarget(path), '伪造会话不能读取课程内资料与作业');
  }

  const returnTo = `${course}/assignments/demo-assignment-prototype?view=pending&scope=mine#version-login-check`;
  const returnWithoutHash = returnTo.split('#')[0];
  assertRedirect(await get(returnWithoutHash), loginTarget(returnWithoutHash), '登录跳转应保留作业详情的筛选参数');
  const editorReturnTo = assignmentEditPath('demo-assignment-observation');
  assertRedirect(await get(editorReturnTo.split('#')[0]), loginTarget(editorReturnTo), '登录后应保留目标作业的编辑查询及可预测的编辑区锚点');
  for (const path of [`${course}/resources?${new URLSearchParams({ q: '受访者' })}`, `${course}/resources/demo-resource-observation?${new URLSearchParams({ q: '受访者' })}`]) {
    assertRedirect(await get(path), loginTarget(path), '匿名打开资料搜索与搜索详情时不能丢失搜索上下文');
  }
  const newOffering = '/manage/courses/course-thinking/new-offering';
  assertRedirect(await get(newOffering), loginTarget(newOffering), '开课登录后应回到原开课表单');
  const loginHtml = await page(loginTarget(returnTo));
  assert.ok(loginHtml.includes(`name="returnTo" value="${escapeAttribute(returnTo)}"`), '演示登录表单应携带安全原目标及显式锚点');
  const loginResponse = await login(origin, 'demo-ta', returnTo);
  assertRedirect(loginResponse, returnTo, '登录成功应回到详情原筛选和显式锚点', 303);
  const returnCookie = loginResponse.headers.get('set-cookie')?.match(/design-course-session=[^;,\s]+/)?.[0];
  assert.ok(returnCookie);
  const alreadyLoggedIn = await page(loginTarget(returnTo), returnCookie);
  assert.ok(hasLink(alreadyLoggedIn, returnTo), '已有会话应能继续返回原页');
  const retryLogin = await page(`${loginTarget(returnTo)}&error=account`);
  assert.ok(retryLogin.includes(`name="returnTo" value="${escapeAttribute(returnTo)}"`), '登录失败重新选择身份时不能丢失原目标');
  const unprivilegedLogin = await login(origin, 'demo-student-a', `${course}/manage`);
  assertRedirect(unprivilegedLogin, `${course}/manage`, '回跳只保存目标，不授予课程管理权限', 303);
  const unprivilegedCookie = unprivilegedLogin.headers.get('set-cookie')?.match(/design-course-session=[^;,\s]+/)?.[0];
  assert.ok(unprivilegedCookie);
  assert.equal((await get(`${course}/manage`, unprivilegedCookie)).status, 404, '登录回跳不能绕过目标页角色检查');
  for (const unsafe of [
    'https://untrusted.invalid/courses/a', '//untrusted.invalid', '/\\untrusted.invalid',
    '/%252funtrusted.invalid', '/api/logout', '/login?returnTo=/courses/a',
    '/courses/%252e%252e/login', '/courses/a?q=%250a',
  ]) assertRedirect(await login(origin, 'demo-ta', unsafe), '/workspace', '恶意回跳应降级到我的课程', 303);
  assertRedirect(await login(origin, 'demo-ta', [returnTo, '//untrusted.invalid']), '/workspace', '重复回跳参数应安全降级', 303);

  for (const [own, other] of [['a', 'b'], ['b', 'a']]) {
    const userId = `demo-student-${own}`;
    const cookie = await loginAs(userId);
    await checkCourseSelection(cookie, userId);
    await checkTeachingReads(cookie, 'STUDENT');
    assertStudentProgress(await page(`${course}/assignments/demo-assignment-prototype?view=history&scope=all`, cookie));
    const html = await page(course, cookie);
    assertCurrentTeaching(html, 'STUDENT');
    assert.ok(hasLink(html, `${course}/groups/group-${own}`), '学生仍应能从导航直达本组');
    assertCurrentTeaching(await page(archivedCourse, cookie), 'STUDENT', archivedCourse, true);
    assertRedirect(await get(`${course}/groups`, cookie), `${course}/groups/group-${own}`, '学生无需再次选择唯一的小组');
    await checkGroupPage(cookie, 'STUDENT', `group-${own}`);
    const otherGroup = await get(`${course}/groups/group-${other}`, cookie);
    assert.equal(otherGroup.status, 404);
    assert.ok(!(await otherGroup.text()).includes(groupNames[other]), '不可在错误响应中泄漏另一组的页面数据');
    assert.equal((await get(`${course}/manage`, cookie)).status, 404);
    assert.equal((await get('/manage/courses/course-thinking/new-offering', cookie)).status, 404);
  }

  const taCookie = await loginAs('demo-ta');
  await checkCourseSelection(taCookie, 'demo-ta');
  await checkTeachingReads(taCookie, 'TA');
  await checkReviewFilters(taCookie, 'TA');
  const taHome = await page(course, taCookie);
  assertCurrentTeaching(taHome, 'TA');
  assertCurrentTeaching(await page(archivedCourse, taCookie), 'TA', archivedCourse, true);
  const taAssignmentRows = [...taHome.matchAll(/data-assignment-scope="mine">([\s\S]*?)<\/div>/g)];
  for (const [, row] of taAssignmentRows) {
    const links = [...row.matchAll(/href="([^"]+)"/g)].map(([, href]) => href.replaceAll('&amp;', '&'));
    assert.equal(new URL(links[0], origin).searchParams.get('scope'), 'mine', '助教首页主操作需保留负责范围');
    assert.ok(links.some(href => new URL(href, origin).searchParams.get('scope') === 'all'), '全班查看应保留为明确的次要入口');
  }
  assert.ok(hasLink(taHome, `${course}/groups`), '助教仍需有全部小组入口');
  const allGroups = await page(`${course}/groups`, taCookie);
  assertCourseFrame(allGroups, 'groups', 'TA');
  assert.equal(linksIn(allGroups).filter(link => link.href === `${course}/groups/group-a`).length, 1, '助教负责的小组应只展示一次');
  assert.ok(hasLink(allGroups, `${course}/groups/group-b`), '助教可浏览未负责的小组');
  const otherGroups = [...allGroups.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)].find(([, , body]) => /<summary\b[^>]*>其他小组<\/summary>/.test(body));
  assert.ok(otherGroups && hasLink(otherGroups[2], `${course}/groups/group-b`), '未负责的小组应保留在按需展开的其他小组入口');
  assert.ok(!/(?:^|\s)open(?:\s|=|$)/.test(otherGroups[1]), '其他小组默认收起，避免与负责范围争抢注意');
  await checkGroupPage(taCookie, 'TA', 'group-b');
  assert.equal((await get(`${course}/manage`, taCookie)).status, 404, '助教浏览权不能扩大为课程管理权');

  const teacherCookie = await loginAs('demo-teacher');
  const teacherCards = await checkCourseSelection(teacherCookie, 'demo-teacher');
  await checkTeachingReads(teacherCookie, 'TEACHER');
  await checkReviewFilters(teacherCookie, 'TEACHER');
  const teacherHome = await page(course, teacherCookie);
  assertCurrentTeaching(teacherHome, 'TEACHER');
  assertCurrentTeaching(await page(archivedCourse, teacherCookie), 'TEACHER', archivedCourse, true);
  const teacherGroups = await page(`${course}/groups`, teacherCookie);
  assertCourseFrame(teacherGroups, 'groups', 'TEACHER');
  for (const suffix of ['a', 'b']) assert.ok(hasLink(teacherGroups, `${course}/groups/group-${suffix}`), '教师仍可通过独立小组目录浏览全班');
  await checkGroupPage(teacherCookie, 'TEACHER', 'group-a');
  assertCourseFrame(await page(`${course}/manage`, teacherCookie), 'manage', 'TEACHER');
  const drafts = teacherCards.filter(card => card.status === 'DRAFT');
  if (drafts.length) {
    // checkCourseSelection already verified that these drafts did not block auto-entry.
    for (const { path } of drafts) {
      const draftHome = await page(path, teacherCookie);
      assertCurrentTeaching(draftHome, 'TEACHER', path);
      assert.ok(draftHome.includes('筹备中'));
    }
  } else skipped.push('无演示教师所属的筹备课，未覆盖「存在 DRAFT 时仍自动进入 ACTIVE」');

  const adminCookie = await loginAs('demo-admin');
  await checkTeachingReads(adminCookie, 'ADMIN');
  await checkReviewFilters(adminCookie, 'ADMIN');
  const adminSelection = await page('/workspace?view=all', adminCookie);
  assertCourseSelection(adminSelection);
  assert.ok(hasLink(adminSelection, course), '无开课成员关系的管理员仍能选择课程');
  const adminHome = await page(course, adminCookie);
  assertCurrentTeaching(adminHome, 'ADMIN');
  assertCurrentTeaching(await page(archivedCourse, adminCookie), 'ADMIN', archivedCourse, true);
  assert.ok(!adminHome.includes('>查看待反馈'), '纯管理员首页不应使用教师的评阅待办入口');
  const adminGroups = await page(`${course}/groups`, adminCookie);
  assertCourseFrame(adminGroups, 'groups', 'ADMIN');
  for (const suffix of ['a', 'b']) assert.ok(hasLink(adminGroups, `${course}/groups/group-${suffix}`), '管理员仍可通过独立小组目录管理各组');
  await checkGroupPage(adminCookie, 'ADMIN', 'group-b');
  assertCourseFrame(await page(`${course}/manage`, adminCookie), 'manage', 'ADMIN');

  let archivedGroupChecks = 0;
  for (const { path } of offeringCards(adminSelection).filter(card => card.status === 'ARCHIVED')) {
    const archivedHome = await page(path, adminCookie);
    assert.ok(archivedHome.includes('已归档'));
    const groupList = await page(`${path}/groups`, adminCookie);
    const groupPaths = new Set([...groupList.matchAll(/href="([^"]+)"/g)].map(([, href]) => href)
      .filter(href => href.startsWith(`${path}/groups/`) && !href.slice(`${path}/groups/`.length).includes('/')));
    for (const groupPath of groupPaths) {
      const html = await checkGroupPage(adminCookie, 'ADMIN', groupPath.slice(`${path}/groups/`.length), path);
      assert.ok(html.includes('只读'), '归档小组应明确显示只读状态');
      assert.ok(!html.includes('编辑项目标题与工作记录'), '管理员也不能看到归档组的编辑入口');
      assert.ok(!/<(?:input|textarea)\b[^>]*\b(?:name|id)="(?:title|body|page-title|page-body)"/.test(html), '归档组不能渲染编辑字段');
      archivedGroupChecks++;
    }
  }
  if (!archivedGroupChecks) skipped.push('归档课程无小组，未覆盖归档小组编辑入口；本检查不创建或修改教学数据');
  if (!submissionTargetChecks) skipped.push('当前可见作业均无「去提交作业」入口，未覆盖未交任务的提交按钮；学生详情的 submission 定位已检查');
} catch (error) {
  failure = error;
} finally {
  const cleanup = await Promise.allSettled([...sessions].map(async cookie => {
    const logout = await fetch(`${origin}/api/logout`, { method: 'POST', redirect: 'manual', headers: { origin, cookie } });
    assert.equal(logout.status, 303);
    assertRedirect(await get('/workspace', cookie), '/login', '退出后服务端会话必须失效');
  }));
  const errors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) failure = new AggregateError([...(failure ? [failure] : []), ...errors], 'HTTP 检查或临时会话清理失败');
}
if (failure) throw failure;
for (const message of skipped) console.log(`SKIP：${message}`);
console.log('HTTP 检查通过：统一课程框架与简短导航、课程选择、教学内容与角色编辑权限、空关联合法性、作业操作定位与编辑深链、资料搜索回链、作业进度与筛选、助教负责范围、匿名和跨期隔离、会话及学生跨组权限；所有临时会话均已退出。');
