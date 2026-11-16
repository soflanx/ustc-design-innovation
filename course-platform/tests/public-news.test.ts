import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { getLegacyPublicProjects, getPublicCourseNews, getPublicOfferingNews, getPublishedPost } from '../src/lib/queries';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(async () => { await db.$disconnect(); });

test('公开新闻始终可读，只有进行中或已归档的关联开课可以进入', async () => {
  const slug = randomUUID();
  const author = await db.user.create({ data: { name: '新闻作者', email: `${slug}@test.invalid` } });
  const post = await db.post.create({ data: {
    slug, type: 'NEWS', title: '课程新闻', body: '公开正文', authorId: author.id,
    status: 'PUBLISHED', visibility: 'PUBLIC', publishedAt: new Date('2026-01-01'),
  } });
  assert.equal((await getPublishedPost(slug))?.offering, null);

  const offering = await db.courseOffering.create({ data: {
    title: '新闻对应的学期开课', status: 'DRAFT',
    course: { create: { slug, title: '新闻测试课程' } },
    term: { create: { slug, name: '2030 秋', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } },
  } });
  await db.post.update({ where: { id: post.id }, data: { offeringId: offering.id } });
  const withDraft = await getPublishedPost(slug);
  assert.equal(withDraft?.body, post.body);
  assert.equal(withDraft.offering, null);

  for (const status of ['ACTIVE', 'ARCHIVED'] as const) {
    await db.courseOffering.update({ where: { id: offering.id }, data: { status } });
    assert.deepEqual((await getPublishedPost(slug))?.offering, { id: offering.id, title: offering.title });
  }
});

test('首页从展示课程各期开课与未绑定新闻中统一取最近六篇，只交付公开卡片字段', async () => {
  const key = randomUUID();
  const author = await db.user.create({ data: { name: '首页新闻作者', email: `${key}@test.invalid` } });
  function offering(name: string, status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT', courseId?: string) {
    return db.courseOffering.create({ data: {
      title: name, status,
      course: courseId ? { connect: { id: courseId } } : { create: { slug: `${key}-${name}`, title: name } },
      term: { create: { slug: `${key}-${name}`, name, startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } },
    } });
  }
  const [thinking, practice, other] = await Promise.all([
    offering('思维', 'ACTIVE'), offering('实践', 'ACTIVE'), offering('未展示课程', 'DRAFT'),
  ]);
  const [archived, draft] = await Promise.all([
    offering('归档实践课', 'ARCHIVED', practice.courseId), offering('筹备实践课', 'DRAFT', practice.courseId),
  ]);
  const now = Date.now();
  function news(name: string, offeringId: string | null, hoursAgo: number) {
    return {
      id: `${key}-${name}`, slug: `${key}-${name}`, title: name, body: `${name}的公开正文`, authorId: author.id, offeringId,
      type: 'NEWS' as const, status: 'PUBLISHED' as const, visibility: 'PUBLIC' as const, publishedAt: new Date(now - hoursAgo * 3_600_000),
    };
  }
  const newest = news('practice', practice.id, 1);
  const tieA = news('a-thinking', thinking.id, 2);
  const tieB = news('b-archived', archived.id, 2);
  const unbound = news('unbound', null, 3);
  const fromDraft = news('public-announcement', draft.id, 4);
  const sixth = news('sixth', thinking.id, 5);
  await db.post.createMany({ data: [
    newest, tieB, tieA, unbound, fromDraft, sixth, news('seventh', archived.id, 6),
    news('other', other.id, 0), news('future', practice.id, -24),
    { ...news('internal', thinking.id, 0), visibility: 'OFFERING' },
    { ...news('draft-post', practice.id, 0), status: 'DRAFT' },
    { ...news('project', practice.id, 0), type: 'PROJECT' },
  ] });
  const cards = await getPublicCourseNews([thinking.courseId, practice.courseId]);
  const expected = [newest, tieA, tieB, unbound, fromDraft, sixth];
  assert.deepEqual(cards, expected.map(({ slug, title, publishedAt }) => ({ slug, title, publishedAt })));
  assert.deepEqual((await getPublicCourseNews([])).map(post => post.slug), [unbound.slug]);
  const announcement = await getPublishedPost(fromDraft.slug);
  assert.equal(announcement?.body, fromDraft.body);
  assert.equal(announcement.offering, null, '公开正文不能带出筹备开课的信息');
});

test('开课报道只列本期已公开新闻，按发布时间与稳定顺序交付必要字段', async () => {
  const key = randomUUID();
  const author = await db.user.create({ data: { name: '开课报道作者', email: `${key}@test.invalid` } });
  function offering(name: string, status: 'ACTIVE' | 'ARCHIVED', courseId?: string) {
    return db.courseOffering.create({ data: {
      title: name, status,
      course: courseId ? { connect: { id: courseId } } : { create: { slug: `${key}-${name}`, title: name } },
      term: { create: { slug: `${key}-${name}`, name, startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } },
    } });
  }
  const current = await offering('本期实践', 'ACTIVE');
  const archived = await offering('往期实践', 'ARCHIVED', current.courseId);
  const other = await offering('另一门课', 'ACTIVE');
  const now = Date.now();
  function news(name: string, offeringId: string | null, hoursAgo: number) {
    return {
      id: `${key}-${name}`, slug: `${key}-${name}`, title: '观察工作坊', body: `${name}的正文`,
      authorId: author.id, offeringId, type: 'NEWS' as const,
      status: 'PUBLISHED' as const, visibility: 'PUBLIC' as const, publishedAt: new Date(now - hoursAgo * 3_600_000),
    };
  }
  const newest = news('newest', current.id, 1);
  const tieA = news('a-current', current.id, 2);
  const tieB = news('b-current', current.id, 2);
  const older = news('older', current.id, 3);
  const previous = news('previous', archived.id, 1);
  await db.post.createMany({ data: [
    older, tieB, previous, newest, tieA, news('other', other.id, 0), news('unbound', null, 0),
    { ...news('internal', current.id, 0), visibility: 'OFFERING' },
    { ...news('draft', current.id, 0), status: 'DRAFT' },
    { ...news('archived-post', current.id, 0), status: 'ARCHIVED' },
    news('future', current.id, -24),
    { ...news('undated', current.id, 0), publishedAt: null },
    { ...news('project', current.id, 0), type: 'PROJECT' },
  ] });
  assert.deepEqual(await getPublicOfferingNews(current.id), [newest, tieA, tieB, older].map(({ slug, title, publishedAt }) => ({ slug, title, publishedAt })));
  assert.deepEqual(await getPublicOfferingNews(archived.id), [{ slug: previous.slug, title: previous.title, publishedAt: previous.publishedAt }]);
  assert.deepEqual(await getPublicOfferingNews(`${key}-missing`), []);
});

test('开课报道按每次请求的发布时间、开课状态和撤回结果重新判断', async t => {
  const key = randomUUID();
  const author = await db.user.create({ data: { name: '定时报道作者', email: `${key}@test.invalid` } });
  const offering = await db.courseOffering.create({ data: {
    title: '筹备中的开课', status: 'DRAFT',
    course: { create: { slug: key, title: '报道状态测试课' } },
    term: { create: { slug: key, name: '2030 秋', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } },
  } });
  const releaseTime = Date.now() + 60_000;
  const post = await db.post.create({ data: {
    slug: key, title: '本期观察报道', body: '已经确认可对外阅读的正文', type: 'NEWS',
    authorId: author.id, offeringId: offering.id, status: 'PUBLISHED', visibility: 'PUBLIC', publishedAt: new Date(releaseTime),
  } });
  t.mock.timers.enable({ apis: ['Date'], now: releaseTime - 1 });
  assert.deepEqual(await getPublicOfferingNews(offering.id), []);
  await db.courseOffering.update({ where: { id: offering.id }, data: { status: 'ACTIVE' } });
  assert.deepEqual(await getPublicOfferingNews(offering.id), []);
  t.mock.timers.setTime(releaseTime);
  const expected = [{ slug: post.slug, title: post.title, publishedAt: post.publishedAt }];
  assert.deepEqual(await getPublicOfferingNews(offering.id), expected);
  await db.courseOffering.update({ where: { id: offering.id }, data: { status: 'ARCHIVED' } });
  assert.deepEqual(await getPublicOfferingNews(offering.id), expected);
  await db.courseOffering.update({ where: { id: offering.id }, data: { status: 'DRAFT' } });
  assert.deepEqual(await getPublicOfferingNews(offering.id), []);
  const standalone = await getPublishedPost(post.slug);
  assert.equal(standalone?.body, post.body);
  assert.equal(standalone?.offering, null);
  await db.courseOffering.update({ where: { id: offering.id }, data: { status: 'ACTIVE' } });
  await db.post.update({ where: { id: post.id }, data: { visibility: 'OFFERING' } });
  assert.deepEqual(await getPublicOfferingNews(offering.id), []);
  assert.equal(await getPublishedPost(post.slug), null);
  await db.post.update({ where: { id: post.id }, data: { visibility: 'PUBLIC', status: 'DRAFT' } });
  assert.deepEqual(await getPublicOfferingNews(offering.id), []);
  await db.post.update({ where: { id: post.id }, data: { status: 'PUBLISHED' } });
  assert.deepEqual(await getPublicOfferingNews(offering.id), expected);
});

test('过往项目文章仍可读，归档只返回公开文章的卡片字段', async () => {
  const key = randomUUID();
  const author = await db.user.create({ data: { name: '项目作者', email: `${key}@test.invalid` } });
  const course = await db.course.create({ data: { slug: key, title: '项目测试课程' } });
  // One offering per course and term, so each status gets its own term.
  const [term, nextTerm] = await Promise.all([['2031 春', '2031-02-01'], ['2031 秋', '2031-09-01']].map(([name, start]) => db.term.create({ data: {
    slug: `${key}-${start}`, name, startDate: new Date(start), endDate: new Date(new Date(start).getTime() + 120 * 86400000),
  } })));
  const archived = await db.courseOffering.create({ data: { title: '项目测试开课 · 已归档', status: 'ARCHIVED', courseId: course.id, termId: term.id } });
  const draft = await db.courseOffering.create({ data: { title: '项目测试开课 · 筹备中', status: 'DRAFT', courseId: course.id, termId: nextTerm.id } });
  const post = (name: string, data: object) => db.post.create({ data: {
    slug: `${key}-${name}`, title: name, body: '正文', excerpt: '一句话问题', authorId: author.id,
    type: 'PROJECT', status: 'PUBLISHED', visibility: 'PUBLIC', publishedAt: new Date('2026-03-01'), ...data,
  } });
  await post('archived', { offeringId: archived.id, publishedAt: new Date('2026-03-03') });
  await post('draft-offering', { offeringId: draft.id, publishedAt: new Date('2026-03-02') });
  await post('unbound', {});
  await post('news', { type: 'NEWS' });
  await post('unpublished', { status: 'DRAFT' });
  await post('members-only', { visibility: 'OFFERING', offeringId: archived.id });
  await post('future', { publishedAt: new Date('2999-01-01') });

  const mine = (await getLegacyPublicProjects()).filter(project => project.slug.startsWith(key));
  assert.deepEqual(mine.map(project => project.slug), ['archived', 'draft-offering', 'unbound'].map(name => `${key}-${name}`));
  assert.deepEqual(Object.keys(mine[0]).sort(), ['excerpt', 'slug', 'title']);
  assert.deepEqual((await getPublishedPost(mine[0].slug))?.offering, { id: archived.id, title: archived.title });
  assert.equal((await getPublishedPost(mine[1].slug))?.offering, null, '筹备中的开课不能随公开项目文章带出');
  assert.equal((await getPublishedPost(mine[2].slug))?.body, '正文');
});
