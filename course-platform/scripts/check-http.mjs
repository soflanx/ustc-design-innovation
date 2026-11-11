import 'dotenv/config';
import assert from 'node:assert/strict';

const origin = new URL(process.env.APP_URL || 'http://127.0.0.1:4174').origin;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('只可检查本机演示服务器。');
const course = '/courses/offering-thinking-2026-autumn';
const archivedCourse = '/courses/offering-thinking-2025-autumn';
const invitationPath = `${course}/groups/join/00000000-0000-4000-8000-000000000000`;
const memberPath = (basePath, suffix) => `${basePath}/members/${basePath.slice('/courses/'.length)}-demo-student-${suffix}`;
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
function checkPublicPage(html, path, entryLabel) {
  const navigation = html.match(/<nav\b[^>]*\baria-label="主导航"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  const footer = html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)?.[1];
  for (const [label, section] of [['主导航', navigation], ['页脚', footer]]) {
    assert.ok(section, `${path} 应包含公开${label}`);
    const entries = linksIn(section).filter(link => link.href === '/workspace');
    assert.deepEqual(entries.map(link => link.text), [entryLabel], `${path} 的${label}应显示“${entryLabel}”`);
  }
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
  assert.match(main ?? '', /<h1\b[^>]*>[\s\S]+?<\/h1>/, `${path} 应呈现公开页面标题`);
  return textContent(main);
}

async function checkPublicEntries(publicHome, studentCookie) {
  const paths = ['/', '/stories'];
  const news = linksIn(publicHome).find(link => /^\/news\/[^/?#]+$/.test(link.href));
  if (news) paths.push(news.href);
  else skipped.push('首页无已发布课程新闻，未覆盖新闻详情的身份入口');
  for (const path of paths) {
    const guestContent = checkPublicPage(path === '/' ? publicHome : await page(path), path, '师生入口');
    const studentContent = checkPublicPage(await page(path, studentCookie), path, '我的课程');
    const nextGuestContent = checkPublicPage(await page(path), path, '师生入口');
    assert.equal(studentContent, guestContent, `${path} 的学生应能阅读同一份公开正文`);
    assert.equal(nextGuestContent, guestContent, `${path} 的后续访客应能阅读同一份公开正文`);
  }
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

function assertAssignmentRequirements(html) {
  assert.match(html, /<h2\b[^>]*>作业要求<\/h2>/, '普通作业页应直接呈现要求');
  assert.doesNotMatch(html, /aria-label="提交概况"|data-submission-owner="/, '普通作业页不应默认加载全班统计名单');
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
  assert.equal(selectionLinks.length, 1, '课程内应只有一个显式课程列表入口');
  assert.equal(selectionLinks[0].text, role === 'ADMIN' ? '全部课程' : '我的课程');
  assert.ok(linksIn(header).some(link => link.href === '/workspace' && link.text === '设计创新'), '教学空间品牌应返回教学入口');
  assert.ok(linksIn(header).some(link => link.href === '/' && link.text === '网站首页'), '公开门户应有含义明确的独立入口');
  assert.ok(!textContent(header).includes('切换课程'), '课程页头不应重复提供切换课程入口');
  const positions = [...html.matchAll(/<header\b[^>]*>([\s\S]*?)<\/header>/g)].map(([, body]) => textContent(body));
  const breadcrumbs = linksIn(html).filter(link => /\bclass="[^"]*\bbreadcrumb\b/.test(link.attributes));
  assert.ok([...positions, ...breadcrumbs.map(link => link.text)].every(text => !text.includes('设计创新思维 · ')), '页头与返回路径不应重复铺开完整课程定位');
  const labels = { overview: '课程首页', lessons: '课次', members: '学生', assignments: '作业', resources: '课程资料', groups: role === 'STUDENT' ? '我的小组' : '小组', team: '教学团队', learning: '本学期记录', manage: '课程管理' };
  const navigations = [...html.matchAll(/<nav\b[^>]*\baria-label="课程导航"[^>]*>([\s\S]*?)<\/nav>/g)];
  assert.ok(navigations.length, '应有统一课程导航');
  for (const [, navigation] of navigations) {
    const links = linksIn(navigation);
    assert.deepEqual(links.slice(0, 3).map(({ text, href }) => [text, href]), [
      ['课程首页', basePath], ['课次', `${basePath}/pages`], ['作业', `${basePath}/assignments`],
    ], '不同角色的前三个课程入口应一致');
    assert.ok(links.some(link => link.text === labels[active] && /\baria-current="page"/.test(link.attributes)), '统一课程导航应指明当前位置');
    assert.equal(hasLink(navigation, `${basePath}/manage`), role === 'TEACHER' || role === 'ADMIN', '统一导航应保留课程管理权限边界');
    assert.equal(hasLink(navigation, `${basePath}/members`), role === 'TEACHER' || role === 'TA', '学生与纯管理员不应看到教学团队的学生目录');
    assert.ok(!links.some(link => [`${basePath}/records`, `${basePath}/feedback`].includes(new URL(link.href, origin).pathname)), '课堂记录与旧指导页不应占据课程主导航');
  }
}

let submissionTargetChecks = 0;
function assertSubmissionTargets(html) {
  for (const link of linksIn(html).filter(link => link.text.startsWith('去提交'))) {
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
  const focus = html.match(/data-course-focus="([^"]+)"/)?.[1];
  assert.ok(['set', 'empty'].includes(focus), '教学内容应明确区分已填写与尚未填写');
  assert.equal([...html.matchAll(/<section\b[^>]*\bdata-course-authored-page\b/g)].length, 1, '课程首页只应有一份可自由编排的教学正文');
  assert.ok(html.includes('aria-label="当前教学内容"') && html.includes('data-course-reading'), '学生与教学团队从同一首页读课程正文');
  assert.doesNotMatch(html, /data-course-lesson-note=|data-course-subpages|data-course-attention|aria-label="(?:近期教学|更新课堂提示|准备新课次|新建课次)"/, '首页不应再渲染固定课次提示、课次目录或快捷表单');
  const canEdit = role !== 'STUDENT' && !archived;
  assert.equal([...html.matchAll(/aria-label="编辑页面正文"/g)].length, Number(canEdit), '有教学编辑权限时首页只提供一个正文编辑器');
  const canManage = role === 'TEACHER' || role === 'ADMIN';
  assert.equal(hasLink(html, `${basePath}/manage`), canManage, '当前教学编辑权不能扩大为课程管理权');
  for (const section of ['pages', 'assignments', 'resources', 'team']) {
    assert.ok(hasLink(html, `${basePath}/${section}`), '不再预览的课程模块应保留导航入口');
  }
  if (role !== 'STUDENT') assert.ok(hasLink(html, `${basePath}/groups`), '教学团队应从导航进入全部小组');
  assert.ok(html.includes('>课程首页</a>'), '课程首页应与网站首页、我的课程区分');
  const tasks = [...html.matchAll(/data-current-task="([^"]+)"/g)];
  const scopes = [...html.matchAll(/data-assignment-scope="([^"]+)"/g)].map(([, scope]) => scope);
  assert.equal(scopes.length, tasks.length, '每个关联任务都应保留角色处理范围');
  for (const scope of scopes) assert.equal(scope, role === 'TA' ? 'mine' : role === 'STUDENT' ? 'self' : 'all');
  if (focus === 'empty') assert.equal(tasks.length, 0, '未填写教学内容时不能自动把全部作业当作本次关联任务');
  if (role === 'STUDENT') {
    if (basePath === course) assert.ok(linksIn(html).some(link => link.href === `${basePath}/assignments` && link.text.startsWith('查看作业与提交情况')), '学生不依赖自由正文即可进入作业');
    const receipts = linksIn(html).filter(link => link.text.startsWith('最近成果'));
    assert.ok(receipts.length <= 1, '首页最多提示一次最近成果');
    for (const { href } of receipts) {
      const target = new URL(href, origin);
      assert.match(target.pathname, /^\/courses\/[^/]+\/assignments\/[^/]+\/submissions\/[^/]+$/);
      assert.equal(target.searchParams.get('fromHome'), '1');
    }
    assertSubmissionTargets(html);
  }
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
      const href = `${course}/${section}/${item.id}${section === 'resources' ? '/open' : ''}`;
      assert.ok(hasLink(html, href), `已发布的 ${item.id} 应出现在本期目录`);
      if (role !== 'STUDENT' && section === 'assignments') {
        assert.ok(hasLink(html, `${href}?view=latest&scope=${role === 'TA' ? 'mine' : 'all'}`), '教学端目录应另提供相应范围的统计入口');
      }
    }
  }
  for (const { section, id, mode } of teachingItems) {
    if (mode) {
      const path = `${course}/${section}/${id}`;
      const html = await page(path, cookie);
      assertCourseFrame(html, section, role);
      assert.ok(html.includes(mode), `${id} 应显示正确的提交方式`);
      assertAssignmentRequirements(html);
      if (role === 'STUDENT') assertStudentProgress(html);
      else {
        const scope = role === 'TA' ? 'mine' : 'all';
        const openStats = linksIn(html).find(link => link.text === '查看提交情况');
        assert.equal(openStats?.href, `${path}?view=latest&scope=${scope}`, '教学团队应主动进入对应范围的统计');
        const statistics = await page(openStats.href, cookie);
        assertReviewView(statistics, 'latest', scope);
        assert.ok(linksIn(statistics).some(link => link.href === path && link.text === '查看作业要求'), '统计中应能返回普通作业阅读');
      }
      assert.ok(linksIn(html).some(link => link.href === `${course}/assignments` && link.text === '← 作业'), '作业详情应提供简短明确的列表回链');
      assert.equal(hasLink(html, assignmentEditPath(id)), canManage, '作业详情应仅为教师或管理员提供直达本作业的编辑链接');
      const editorPage = await page(`${course}/assignments?${new URLSearchParams({ edit: id })}`, cookie);
      assertCourseFrame(editorPage, 'assignments', role);
      assertAssignmentEditor(editorPage, id, canManage);
    } else {
      const detail = `${course}/resources/${id}`;
      assertRedirect(await get(detail, cookie), detail + '/open', '旧资料地址应直达文件入口');
      const file = await get(detail + '/open', cookie);
      assert.equal(file.status, 200, '成员可以下载已有文字资料');
      assert.match(file.headers.get('content-disposition') ?? '', /^attachment;.*\.txt/i);
      assert.match(file.headers.get('cache-control') ?? '', /no-store/);
      assert.match(await file.text(), /受访者/, '旧文字资料以原文返回');
      assert.equal((await get(`${archivedCourse}/resources/${id}/open`, cookie)).status, 404);
    }
    assert.equal((await get(`${archivedCourse}/${section}/${id}`, cookie)).status, 404, '不能通过改写学期路径读取另一学期的资料或作业');
  }
  for (const section of ['resources', 'assignments']) {
    assert.equal((await get(`${course}/${section}/nonexistent-http-check`, cookie)).status, 404, '不存在的教学记录应返回 404');
  }
  const searchQuery = `?${new URLSearchParams({ q: '受访者' })}`;
  const bodySearch = await page(`${course}/resources${searchQuery}`, cookie);
  assertCourseFrame(bodySearch, 'resources', role);
  const searchedResource = `${course}/resources/demo-resource-observation`;
  assert.ok(hasLink(bodySearch, searchedResource + '/open'), '搜索结果应匹配已授权文字并直接打开资料');
  const editLink = linksIn(bodySearch).find(link => {
    const url = new URL(link.href, origin);
    return url.pathname === searchedResource && url.searchParams.get('edit') === '1';
  });
  assert.equal(!!editLink, canManage, '只有教师和管理员可以看到资料编辑入口');
  if (editLink) {
    assert.equal(new URL(editLink.href, origin).searchParams.get('q'), '受访者');
    const editPage = await page(editLink.href, cookie);
    assertCourseFrame(editPage, 'resources', role);
    assert.ok(hasLink(editPage, `${course}/resources${searchQuery}`), '编辑完成后可返回原搜索结果');
  }
  const noMatch = await page(`${course}/resources?q=HTTP-SEARCH-NO-MATCH-49de3c1f`, cookie);
  assert.ok(!hasLink(noMatch, searchedResource + '/open'), '无匹配搜索不应保留全部资料');
  assertCourseFrame(await page(`${course}/team`, cookie), 'team', role);
}

function reviewFilterLinks(html) {
  const navigation = html.match(/<nav\b[^>]*\baria-label="提交筛选"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(navigation, '评阅页应呈现提交筛选导航');
  return new Map(linksIn(navigation).map(link => {
    const count = link.text.match(/\s*\(\s*(\d+)\s*\)$/);
    const view = new URL(link.href, origin).searchParams.get('view');
    return [view, { href: link.href, label: count ? link.text.slice(0, count.index).trim() : link.text, count: count ? Number(count[1]) : null }];
  }));
}

async function checkReviewFilters(cookie, role) {
  const path = `${course}/assignments/demo-assignment-prototype`;
  const defaultScope = role === 'TA' ? 'mine' : 'all';
  const historyVersions = new Map();
  for (const scope of role === 'TA' ? ['mine', 'all'] : ['all']) {
    const start = await page(`${path}?view=pending&scope=${scope}`, cookie);
    assertReviewView(start, 'pending', scope);
    assert.match(start, /<h2\b[^>]*>提交情况<\/h2>/, '已交和评阅数字应在提交情况中直接可读');
    const entryLinks = reviewFilterLinks(start);
    const historyLink = entryLinks.get('history');
    assert.equal(historyLink?.href, `${path}?view=history&scope=${scope}`, '待评阅队列应提供带原范围的更正历史入口');
    const history = await page(historyLink.href, cookie);
    assertReviewView(history, 'history', 'all');
    assert.doesNotMatch(history, /<article\b[^>]*\bid="version-/, '统计历史仅列版本，作品正文与评语在独立成果页');
    const versions = new Set([...history.matchAll(/<div\b[^>]*\bid="version-([^"]+)"/g)].map(([, id]) => id));
    historyVersions.set(scope, versions);
    const workLinks = linksIn(history).map(link => new URL(link.href, origin)).filter(url => url.pathname.startsWith(`${path}/submissions/`));
    assert.deepEqual(new Set(workLinks.map(url => decodeURIComponent(url.pathname.split('/').at(-1)))), versions, '每条历史版本都应直达自己的作品');
    if (workLinks.length) {
      const work = workLinks[0];
      assert.equal(work.searchParams.get('view'), 'history');
      assert.equal(work.searchParams.get('scope'), scope);
      assert.equal(work.searchParams.get('fromStats'), '1');
      const detail = await page(work.pathname + work.search, cookie);
      assertCourseFrame(detail, 'assignments', role);
      const versionId = decodeURIComponent(work.pathname.split('/').at(-1));
      assert.deepEqual([...detail.matchAll(/<article\b[^>]*\bid="version-([^"]+)"/g)].map(([, id]) => id), [versionId], '独立作品页只呈现请求的正式版本');
      assert.ok(linksIn(detail).some(link => link.href === historyLink.href && link.text === '← 返回提交情况'), '独立作品应能返回原统计范围');
      if (role === 'TA' && scope === 'all') {
        assert.equal((await get(`${archivedCourse}/assignments/demo-assignment-prototype/submissions/${encodeURIComponent(versionId)}`, cookie)).status, 404, '作品 ID 不能绕过开课范围');
        assert.equal((await get(`${course}/assignments/demo-assignment-observation/submissions/${encodeURIComponent(versionId)}`, cookie)).status, 404, '作品 ID 不能绕过作业范围');
      }
    }
    const queueLinks = reviewFilterLinks(history);
    assert.deepEqual(new Set(queueLinks.keys()), new Set(entryLinks.keys()), '更正历史的返回入口应与原工作范围的筛选项一致');
    const owners = new Map();
    for (const [view, label] of Object.entries({ latest: '已交', pending: '待评阅', completed: '已评阅', missing: '未交', unconfirmed: '历史待核对' })) {
      if (view === 'unconfirmed' && !entryLinks.has(view)) continue;
      const link = queueLinks.get(view);
      assert.ok(link, `应有${label}入口`);
      assert.ok(link.label === label || (view === 'missing' && link.label === '逾期未交'), `统计应明确显示${label}`);
      assert.equal(link.count, entryLinks.get(view).count, `${scope} 返回${label}的计数应与原队列一致`);
      const result = await page(link.href, cookie);
      assertReviewView(result, view, scope);
      const rows = submissionOwners(result);
      assert.equal(rows.size, link.count, `${scope} ${label}显示的数量应与实际返回的行数一致`);
      if (scope === 'mine') for (const id of rows) assert.equal(id, 'group-a', '助教负责组筛选不能混入未负责的 B 组');
      owners.set(view, rows);
    }
    const latest = owners.get('latest');
    const missing = owners.get('missing');
    for (const id of latest) assert.ok(!missing.has(id), '同一归属不能同时出现在已交与未交列表');
    for (const id of owners.get('pending')) assert.ok(latest.has(id), '待评阅应只包含已交的最新版本');
    for (const id of owners.get('completed')) {
      assert.ok(latest.has(id), '已评阅应只包含已交的最新版本');
      assert.ok(!owners.get('pending').has(id), '同一版本不能同时待评阅和已评阅');
    }
    const currentOwners = new Set([...latest, ...missing]);
    for (const id of scope === 'mine' ? ['group-a'] : ['group-a', 'group-b']) {
      assert.ok(currentOwners.has(id), '已交与未交名单应覆盖当前范围的有效小组');
    }
  }
  if (role === 'TA') assert.deepEqual(historyVersions.get('mine'), historyVersions.get('all'), '进入更正历史的工作范围不能限制实际显示的历史版本');
  if (role === 'TA' && !historyVersions.get('all').size) skipped.push('演示小组作业尚无正式版本，未覆盖从统计到真实作品的回链');
  const history = await page(`${path}?view=history&scope=mine`, cookie);
  assertReviewView(history, 'history', 'all');
  const invalid = await page(`${path}?view=invalid-http-check&scope=group-b`, cookie);
  assertAssignmentRequirements(invalid);
  assertReviewView(await page(`${path}?view=latest&scope=group-b`, cookie), 'latest', defaultScope);
  assert.equal((await get(`${path}/submissions/nonexistent-http-check`, cookie)).status, 404, '不存在的具体作品不能降级为另一份提交');
  if (role === 'TA') {
    assertReviewView(await page(`${path}?view=latest&scope=unassigned`, cookie), 'latest', 'mine');
  }
}

async function checkUnassignedPersonalSubmissions(cookie) {
  const assignment = `${course}/assignments/demo-assignment-observation`;
  const directory = await page(`${course}/assignments`, cookie);
  const findUnassigned = html => linksIn(html).find(link => {
    const target = new URL(link.href, origin);
    return target.pathname === assignment && target.searchParams.get('scope') === 'unassigned';
  });
  const fromDirectory = findUnassigned(directory);
  const overview = await page(`${assignment}?view=latest&scope=mine`, cookie);
  const fromAssignment = findUnassigned(overview);
  assert.equal(!!fromAssignment, !!fromDirectory, '有未分组个人作业对象时目录和详情都应提供独立入口');
  const selected = await page(fromDirectory?.href ?? `${assignment}?view=latest&scope=unassigned`, cookie);
  assertReviewView(selected, 'latest', 'unassigned');
  const missing = reviewFilterLinks(selected).get('missing');
  assert.ok(missing, '已发布个人作业应提供未交名单');
  const missingPage = await page(missing.href, cookie);
  assertReviewView(missingPage, 'missing', 'unassigned');
  const selectedOwners = new Set([...submissionOwners(selected), ...submissionOwners(missingPage)]);
  if (fromDirectory) {
    assert.match(fromDirectory.text, /未分组学生/);
    assert.ok(selectedOwners.size, '独立入口应能找到实际未分组对象');
    for (const view of ['latest', 'missing']) {
      const mine = await page(`${assignment}?view=${view}&scope=mine`, cookie);
      for (const id of submissionOwners(mine)) assert.ok(!selectedOwners.has(id), '未分组学生不能被算成助教已分工对象');
    }
  } else {
    assert.equal(selectedOwners.size, 0, '当前没有未分组学生时，直链不应混入已分组对象');
  }
}

async function checkTeachingHistory(cookie, role, basePath = course) {
  const directoryPath = `${basePath}/members`;
  const directory = await page(directoryPath, cookie);
  assertCourseFrame(directory, 'members', role, basePath);
  assert.ok(hasLink(directory, memberPath(basePath, 'a')), '助教能直接找到已有学生，无需从观察或组记录进入');
  const query = `?${new URLSearchParams({ q: '演示学生 A' })}`;
  const search = await page(directoryPath + query, cookie);
  const detailPath = memberPath(basePath, 'a') + query;
  assert.ok(hasLink(search, detailPath), '姓名查询应保留到学生记录入口');
  assert.ok(!hasLink(search, memberPath(basePath, 'b') + query), '查找一个姓名不应混入其他学生');
  const detail = await page(detailPath, cookie);
  assertCourseFrame(detail, 'members', role, basePath);
  assert.ok(hasLink(detail, directoryPath + query), '学生回顾应返回原姓名查询');
  assert.doesNotMatch(detail, /id="(?:classroom-history|assignment-history|membership-history|guidance-history)"/, '学生页不应重复铺设四类空栏目');
  const sections = detail.match(/aria-labelledby="teaching-(?:remarks|classroom|submissions)"/g) ?? [];
  if (!sections.length && !textContent(detail).includes('以前发给')) assert.match(textContent(detail), /暂无记录/, '零记录学生只需有简短空态');
  assert.equal([...detail.matchAll(/<summary\b[^>]*>记个人备注<\/summary>/g)].length, Number(basePath !== archivedCourse), '教师与助教仅在可写课程看到个人备注入口');
  assert.ok(!textContent(detail).includes('补充类型、来源或日期'), '个人备注不再混入课堂事件类型');
  if (basePath === archivedCourse) {
    assert.ok(textContent(detail).includes('课程已归档'), '归档仍可按姓名回看学生');
  }
  assertRedirect(await get(`${basePath}/records`, cookie), `${basePath}/pages`, '未指定课次的旧记录入口应回到课次目录');
}

async function assertNoInternalTeachingAccess(cookie) {
  for (const path of [`${course}/members`, memberPath(course, 'a'), `${course}/records`]) {
    const denied = await get(path, cookie);
    assert.equal(denied.status, 404, '只有本期教学团队可以访问学习记录与内部课堂记录');
    assert.doesNotMatch(await denied.text(), /id="(?:lesson-records-title|member-search|record-[^"]+)"|aria-label="本期记录"/, '错误响应不能渲染内部记录或学生目录');
  }
}

async function checkLessonDirectory(cookie, role, basePath = course) {
  const directory = await page(`${basePath}/pages`, cookie);
  assertCourseFrame(directory, 'lessons', role, basePath);
  assert.equal(directory.includes('aria-label="新建课次"'), role !== 'STUDENT' && basePath !== archivedCourse, '课次目录遵循教学编辑权限和归档只读');
  if (role === 'STUDENT' || role === 'ADMIN') assert.ok(!linksIn(directory).some(link => new URL(link.href, origin).searchParams.get('view') === 'records'), '学生或纯管理员不可从课次目录进入内部记录');
  return directory;
}

async function checkLessonEntry(taCookie, studentCookie, adminCookie) {
  const directory = await checkLessonDirectory(taCookie, 'TA');
  const studentDirectory = await checkLessonDirectory(studentCookie, 'STUDENT');
  const rows = [...directory.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].flatMap(([, body]) => {
    const content = linksIn(body).find(link => link.href.startsWith(`${course}/pages/`) && !new URL(link.href, origin).search);
    return content ? [{ ...content, draft: /<small\b[^>]*>草稿<\/small>/.test(body), body }] : [];
  });
  const draft = rows.find(item => item.draft);
  const published = rows.find(item => !item.draft);
  if (!draft) skipped.push('无演示课次草稿，未覆盖草稿课次与课堂记录的访问边界');
  if (!published) skipped.push('无已发布演示课次，未覆盖已发布课次中公开内容与内部记录的分离');
  let checkedPrivateIds = 0;
  for (const item of [draft, published].filter(Boolean)) {
    const recordPath = `${item.href}?view=records`;
    assert.ok(hasLink(item.body, recordPath), '助教能从课次目录进入本课记录');
    const lesson = await page(item.href, taCookie);
    assertCourseFrame(lesson, 'lessons', 'TA');
    assert.ok(linksIn(lesson).some(link => link.href === recordPath && link.text === '课堂记录'), '课次内容中应有本课记录切换入口');
    const records = await page(recordPath, taCookie);
    assertCourseFrame(records, 'lessons', 'TA');
    assert.ok(linksIn(records).some(link => link.href === item.href && link.text === '课程内容'), '本课记录应能回到同一课的课程内容');
    assert.match(records, /id="lesson-records-title"/);
    assert.equal([...records.matchAll(/<summary\b[^>]*>记一笔<\/summary>/g)].length, 1, '本课只应有一个默认记事入口');
    assert.equal([...records.matchAll(/<summary\b[^>]*>记学生情况<\/summary>/g)].length, 1, '本课应能直接选择多名学生记录情况');
    assert.doesNotMatch(records, /aria-label="筛选课堂记录"|id="classroom-(?:page|student)"/, '本课记录无需再筛选整学期的课次和学生');
    const privateIds = [...records.matchAll(/<li\b[^>]*\bid="record-([^"]+)"/g)].map(([, id]) => id);
    checkedPrivateIds += privateIds.length;
    const assertNoPrivateIds = html => {
      for (const id of privateIds) assert.ok(!html.includes(id), '完整响应及其序列化载荷不能泄漏实际内部记录 ID');
    };
    const pageId = decodeURIComponent(item.href.split('/').at(-1));
    const oldQuery = new URLSearchParams({ fromPage: pageId, includeWithdrawn: '1' });
    assertRedirect(await get(`${course}/records?${oldQuery}`, taCookie), `${recordPath}&includeWithdrawn=1`, '旧课次记录入口应转到同课并保留历史选项');
    assert.equal((await get(`${archivedCourse}/records?${oldQuery}`, taCookie)).status, 404, '旧记录入口也必须校验课次的开课归属');
    assertRedirect(await get(recordPath), loginTarget(recordPath), '匿名用户应先登录再进入同课记录');
    for (const actor of [studentCookie, adminCookie]) {
      const denied = await get(`${recordPath}&includeWithdrawn=1`, actor);
      assert.equal(denied.status, 404, '学生和纯管理员通过直链也不可读课次内部记录');
      const errorPage = await denied.text();
      assert.doesNotMatch(errorPage, /id="(?:lesson-records-title|record-[^"]+)"/);
      assertNoPrivateIds(errorPage);
      assert.equal((await get(`${course}/records?${oldQuery}`, actor)).status, 404);
    }
    assertNoPrivateIds(studentDirectory);
    assertNoPrivateIds(await page(item.href, adminCookie));
    assert.equal(hasLink(studentDirectory, item.href), !item.draft, '学生目录只能发现已发布课次');
    if (item.draft) {
      const denied = await get(item.href, studentCookie);
      assert.equal(denied.status, 404, '学生不能通过内容直链读取课次草稿');
      assert.ok(!textContent(await denied.text()).includes(item.text), '错误页不泄漏课次草稿标题');
    } else {
      const readable = await page(item.href, studentCookie);
      assertCourseFrame(readable, 'lessons', 'STUDENT');
      assert.ok(!hasLink(readable, recordPath), '已发布课次也不应显示学生无权读取的记录入口');
      assertNoPrivateIds(readable);
    }
  }
  if (rows.length && !checkedPrivateIds) skipped.push('所核对课次尚无内部记录，未覆盖完整响应中的实际记录 ID');
  assert.equal((await get(`${course}/records?fromPage=missing-lesson&fromPage=missing-lesson`, taCookie)).status, 404, '重复的旧课次参数不能成为全期记录入口');
  assert.equal((await get(`${course}/pages/nonexistent-http-check?view=records`, taCookie)).status, 404, '不存在的课次不能退回全期记录');
}

async function checkGroupPage(cookie, role, groupId, basePath = course) {
  const html = await page(`${basePath}/groups/${groupId}`, cookie);
  assertCourseFrame(html, 'groups', role, basePath);
  if (role !== 'STUDENT') {
    assert.ok(linksIn(html).some(link => link.href === `${basePath}/groups` && link.text === '← 小组'), '教学团队查看小组记录后应有明确的目录回链');
  }
  const teaching = role === 'TEACHER' || role === 'TA';
  assert.doesNotMatch(html, /id="(?:classroom-history|assignment-history|guidance-history)"/, '小组回顾使用一个阅读流，避免空栏目');
  const records = html.match(/<ol\b[^>]*\baria-label="本期记录"[^>]*>/g) ?? [];
  assert.ok(records.length <= Number(teaching), '小组本期记录只向本期教学团队呈现');
  assert.equal([...html.matchAll(/<summary\b[^>]*>记一笔<\/summary>/g)].length, Number(teaching && basePath !== archivedCourse), '小组最多显示一个有权限的记事入口');
  return html;
}

let failure;
try {
  const publicHome = await page('/');
  assert.ok(linksIn(publicHome).some(link => link.href === '/' && link.text === '设计创新'), '公开首页品牌仍返回公开门户');
  assert.ok(linksIn(publicHome).some(link => link.href === '/workspace' && link.text === '师生入口'), '访客应有明确师生入口');
  assertRedirect(await get('/workspace'), '/login', '未登录应进入登录页');
  assertRedirect(await get(invitationPath), loginTarget(invitationPath), '匿名打开小组邀请应保留登录后的邀请地址');
  const invitationLogin = await page(loginTarget(invitationPath));
  assert.ok(invitationLogin.includes(`name="returnTo" value="${escapeAttribute(invitationPath)}"`), '邀请登录表单应保留原邀请地址');
  assert.equal((await login('https://untrusted.invalid', 'demo-student-a')).status, 403);
  assert.equal((await login(origin, 'unlisted-account')).status, 400);
  assertRedirect(await get('/workspace', 'design-course-session=' + '0'.repeat(64)), '/login', '伪造会话不可访问课程');
  for (const path of [
    `${course}/resources`, `${course}/resources/demo-resource-observation/open`, `${course}/assignments`, `${course}/pages`, `${course}/records`,
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
  await checkPublicEntries(publicHome, unprivilegedCookie);
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
    if (own === 'a') {
      await assertNoInternalTeachingAccess(cookie);
      const records = `${course}/learning`;
      assert.ok(linksIn(html).some(link => link.href === records && link.text === '本学期记录'), '课程首页应提供本学期记录入口');
      const recordsPage = await page(records, cookie);
      assertCourseFrame(recordsPage, 'learning', 'STUDENT');
      assert.ok(recordsPage.includes('id="records"'), '本学期记录应保留原作业的返回锚点');
      const assignment = await page(`${course}/assignments/demo-assignment-prototype?view=history&fromLearning=1`, cookie);
      assert.ok(linksIn(assignment).some(link => link.href === `${records}#records` && link.text === '← 返回本学期记录'), '从本学期记录打开原作业时应能返回记录');
      const invitation = await page(invitationPath, cookie);
      assert.match(invitation, /<meta\b(?=[^>]*\bname="referrer")(?=[^>]*\bcontent="same-origin")[^>]*>/, '邀请页应使用同源来源策略');
      const invitationText = textContent(invitation);
      assert.ok(invitationText.includes('你已加入') && invitationText.includes(groupNames[own]), '已入组学生应看到本组状态');
      assert.doesNotMatch(invitationText, /确认加入/, '已入组学生不能从邀请页确认加入');
    }
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
  assert.equal((await get(invitationPath, taCookie)).status, 404, '助教身份不能使用学生邀请入口');
  await checkCourseSelection(taCookie, 'demo-ta');
  await checkTeachingReads(taCookie, 'TA');
  await checkReviewFilters(taCookie, 'TA');
  await checkUnassignedPersonalSubmissions(taCookie);
  await checkTeachingHistory(taCookie, 'TA');
  await checkTeachingHistory(taCookie, 'TA', archivedCourse);
  const wrongTermMember = `${archivedCourse}/members/${memberPath(course, 'a').split('/').at(-1)}`;
  assert.equal((await get(wrongTermMember, taCookie)).status, 404, '同一助教的两期课程也不能交叉读取学生记录');
  const taHome = await page(course, taCookie);
  assertCurrentTeaching(taHome, 'TA');
  assertCurrentTeaching(await page(archivedCourse, taCookie), 'TA', archivedCourse, true);
  const taAssignmentRows = [...taHome.matchAll(/<article\b[^>]*\bdata-assignment-scope="mine"[^>]*>([\s\S]*?)<\/article>/g)];
  assert.equal(taAssignmentRows.length, [...taHome.matchAll(/data-current-task=/g)].length, '助教的每项首页作业都应纳入引用入口核对');
  if (!taAssignmentRows.length) skipped.push('演示首页没有引用作业，首页引用入口未覆盖，作业目录已检查');
  for (const [, row] of taAssignmentRows) {
    const links = linksIn(row);
    const primary = new URL(links[0].href, origin);
    assert.match(primary.pathname, /^\/courses\/[^/]+\/assignments\/[^/]+$/);
    assert.equal(primary.search, '', '助教首页作业标题应先打开要求');
    assert.equal(links.filter(link => link.href === links[0].href).length, 1, '作业标题是唯一主入口');
    assert.ok(!links.some(link => new URL(link.href, origin).searchParams.has('view')), '首页引用保持简洁，提交情况从原作业页进入');
  }
  assert.ok(hasLink(taHome, `${course}/groups`), '助教仍需有全部小组入口');
  const allGroups = await page(`${course}/groups`, taCookie);
  assertCourseFrame(allGroups, 'groups', 'TA');
  assert.equal(linksIn(allGroups).filter(link => link.href === `${course}/groups/group-a`).length, 1, '助教负责的小组应只展示一次');
  assert.ok(hasLink(allGroups, `${course}/groups/group-b`), '助教可浏览未负责的小组');
  const otherGroups = [...allGroups.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)].find(([, , body]) => /<summary\b[^>]*>其他小组<\/summary>/.test(body));
  assert.ok(otherGroups && hasLink(otherGroups[2], `${course}/groups/group-b`), '未负责的小组应保留在按需展开的其他小组入口');
  assert.ok(!/(?:^|\s)open(?:\s|=|$)/.test(otherGroups[1]), '其他小组默认收起，避免与负责范围争抢注意');
  const taGroup = await checkGroupPage(taCookie, 'TA', 'group-b');
  const groupMemberPath = `${memberPath(course, 'b')}?fromGroup=group-b`;
  assert.ok(hasLink(taGroup, groupMemberPath), '小组回顾能打开成员在本期的记录');
  const groupMember = await page(groupMemberPath, taCookie);
  assertCourseFrame(groupMember, 'members', 'TA');
  assert.ok(linksIn(groupMember).some(link => link.href === `${course}/groups/group-b` && link.text === `← ${groupNames.b}`), '成员记录能返回来源小组');
  assert.equal((await get(`${course}/manage`, taCookie)).status, 404, '助教浏览权不能扩大为课程管理权');

  const teacherCookie = await loginAs('demo-teacher');
  const signedInPublicHome = await page('/', teacherCookie);
  assert.ok(linksIn(signedInPublicHome).some(link => link.href === '/workspace' && link.text === '我的课程'), '已登录仍可查看公开门户并返回教学入口');
  const teacherCards = await checkCourseSelection(teacherCookie, 'demo-teacher');
  await checkTeachingReads(teacherCookie, 'TEACHER');
  await checkReviewFilters(teacherCookie, 'TEACHER');
  await checkTeachingHistory(teacherCookie, 'TEACHER');
  const teacherHome = await page(course, teacherCookie);
  assertCurrentTeaching(teacherHome, 'TEACHER');
  assertCurrentTeaching(await page(archivedCourse, teacherCookie), 'TEACHER', archivedCourse, true);
  await checkLessonDirectory(teacherCookie, 'TEACHER', archivedCourse);
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
  await assertNoInternalTeachingAccess(adminCookie);
  await checkLessonDirectory(adminCookie, 'ADMIN');
  await checkLessonEntry(taCookie, unprivilegedCookie, adminCookie);
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
console.log('HTTP 检查通过：课程导航与自由正文、课次和内部记录、作业要求与统计、独立成果回链、学生及小组回顾、角色和跨期权限，以及会话退出。');
