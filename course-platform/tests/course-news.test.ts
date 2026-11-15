import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import sharp from 'sharp';
import { db } from '../src/lib/db';
import { DomainError } from '../src/lib/management';
import {
  getCourseNews, getCourseNewsDraftCover, publishCourseNews, saveCourseNewsDraft, withdrawCourseNews,
} from '../src/lib/course-news';
import { getPublicNews, getPublicOfferingNews, getPublishedNewsCover, getPublishedPost } from '../src/lib/queries';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(() => db.$disconnect());

async function fixture() {
  const key = randomUUID();
  const offering = await db.courseOffering.create({ data: {
    title: '本期观察工作坊', status: 'ACTIVE',
    course: { create: { slug: key, title: '设计创新实践' } },
    term: { create: { slug: key, name: '测试秋季学期', startDate: new Date('2025-09-01'), endDate: new Date('2026-01-01') } },
  } });
  const [teacher, ta, student] = await Promise.all((['TEACHER', 'TA', 'STUDENT'] as const).map(role =>
    db.user.create({ data: {
      name: role, email: `${key}-${role}@test.invalid`, memberships: { create: { offeringId: offering.id, role } },
    } }),
  ));
  return { offering, teacher: teacher.id, ta: ta.id, student: student.id };
}

async function coverFile(background: string) {
  const bytes = await sharp({ create: { width: 640, height: 400, channels: 3, background } }).png().toBuffer();
  return new File([Uint8Array.from(bytes)], '工作坊封面.png', { type: 'image/png' });
}

test('教师和助教共用新闻草稿，最新确认才替换同一公开地址的正文与封面', async () => {
  const { offering, teacher, ta, student } = await fixture();
  const offeringId = offering.id;
  const first = {
    title: '校园观察工作坊', excerpt: '从一次观察开始。', body: '学生比较了两个入口的行走路线。',
    cover: await coverFile('#224477'), coverAlt: '桌面上的蓝色模型', coverCaption: '第一轮观察使用的模型。',
  };
  const requestId = randomUUID();
  const create = () => saveCourseNewsDraft(teacher, offeringId, null, requestId, first);
  const [created, retry] = await Promise.all([create(), create()]);
  assert.deepEqual(retry, created);
  const { id, slug } = created;
  assert.equal(await db.post.count({ where: { offeringId, type: 'NEWS' } }), 1);

  const initial = await getCourseNews(ta, offeringId, id);
  assert.ok(initial);
  const oldCover = initial.draft.cover;
  assert.ok(oldCover);
  assert.equal(initial.draft.body, first.body);
  assert.equal(oldCover.alt, first.coverAlt);
  assert.equal(oldCover.caption, first.coverCaption);
  const oldFile = await getCourseNewsDraftCover(ta, offeringId, id, oldCover.id);
  assert.ok(oldFile);
  assert.equal(oldFile.contentType, 'image/webp');
  assert.equal((await sharp(Buffer.from(oldFile.bytes)).metadata()).format, 'webp');
  assert.equal(await getCourseNewsDraftCover(student, offeringId, id, oldCover.id), null);
  assert.equal(await getPublishedPost(slug), null);
  assert.equal(await getPublishedNewsCover(slug, oldCover.id), null);
  assert.deepEqual(await getPublicOfferingNews(offeringId), []);

  await publishCourseNews(teacher, offeringId, id, created.revision);
  const published = await getPublishedPost(slug);
  assert.ok(published);
  assert.deepEqual([published.title, published.excerpt, published.body], [first.title, first.excerpt, first.body]);
  assert.deepEqual(published.offering, { id: offeringId, title: offering.title });
  assert.deepEqual(published.publishedCover, oldCover);
  assert.equal(published.useLegacyCover, false);
  assert.deepEqual(await getPublishedNewsCover(slug, oldCover.id), oldFile);
  const afterPublish = await getCourseNews(ta, offeringId, id);
  assert.ok(afterPublish?.isPublic);
  assert.equal(afterPublish.hasUnpublishedChanges, false);

  const revised = {
    title: '校园观察与模型测试', excerpt: '两轮模型带来了不同发现。', body: '学生改动了引导标记并再次测试。',
    cover: await coverFile('#993322'), coverAlt: '更新后的红色模型', coverCaption: '第二轮测试采用的模型。',
  };
  const next = await saveCourseNewsDraft(ta, offeringId, { postId: id, revision: afterPublish.revision }, randomUUID(), revised);
  assert.equal(next.slug, slug);
  const shared = await getCourseNews(teacher, offeringId, id);
  assert.ok(shared?.hasUnpublishedChanges);
  assert.equal(shared.draft.body, revised.body);
  const newCover = shared.draft.cover;
  assert.ok(newCover);
  assert.equal(newCover.alt, revised.coverAlt);
  assert.equal(newCover.caption, revised.coverCaption);
  const newFile = await getCourseNewsDraftCover(teacher, offeringId, id, newCover.id);
  assert.ok(newFile);
  assert.notDeepEqual(newFile.bytes, oldFile.bytes);
  assert.equal(await getPublishedNewsCover(slug, newCover.id), null);
  await assert.rejects(publishCourseNews(teacher, offeringId, id, afterPublish.revision), DomainError);
  assert.deepEqual(await getPublishedPost(slug), published);
  assert.deepEqual(await getPublishedNewsCover(slug, oldCover.id), oldFile);
  assert.equal((await getPublicNews()).find(post => post.slug === slug)?.excerpt, first.excerpt);

  await publishCourseNews(ta, offeringId, id, next.revision);
  await assert.rejects(withdrawCourseNews(teacher, offeringId, id, shared.revision, shared.publishedRevision), /公开新闻已有更新/);
  const updated = await getPublishedPost(slug);
  assert.ok(updated);
  assert.deepEqual([updated.title, updated.excerpt, updated.body], [revised.title, revised.excerpt, revised.body]);
  assert.deepEqual(updated.publishedCover, newCover);
  assert.deepEqual(await getPublishedNewsCover(slug, newCover.id), newFile);
  assert.equal(await getPublishedNewsCover(slug, oldCover.id), null);

  const afterUpdate = await getCourseNews(teacher, offeringId, id);
  assert.ok(afterUpdate);
  const pending = { ...revised, cover: undefined, body: '保留待下次讨论的第三版草稿。' };
  const pendingDraft = await saveCourseNewsDraft(ta, offeringId, { postId: id, revision: afterUpdate.revision }, randomUUID(), pending);
  await db.courseOffering.update({ where: { id: offeringId }, data: { status: 'ARCHIVED' } });
  await assert.rejects(saveCourseNewsDraft(ta, offeringId, { postId: id, revision: pendingDraft.revision }, randomUUID(), {
    ...pending, title: '归档后改正文',
  }), DomainError);
  await assert.rejects(publishCourseNews(ta, offeringId, id, pendingDraft.revision), DomainError);
  assert.deepEqual(await getPublishedPost(slug), updated);
  assert.deepEqual(await getPublishedNewsCover(slug, newCover.id), newFile);
  await withdrawCourseNews(teacher, offeringId, id, pendingDraft.revision, afterUpdate.publishedRevision);
  await withdrawCourseNews(teacher, offeringId, id, pendingDraft.revision, afterUpdate.publishedRevision);
  assert.equal(await getPublishedPost(slug), null);
  assert.equal(await getPublishedNewsCover(slug, newCover.id), null);
  assert.deepEqual(await getPublicOfferingNews(offeringId), []);
  assert.equal((await getCourseNews(ta, offeringId, id))?.draft.body, pending.body);
});

test('学生与同课其他期无法改写新闻，旧公开报道沿用原地址和封面', async () => {
  const { offering, teacher, student } = await fixture();
  const other = await db.courseOffering.create({ data: {
    course: { connect: { id: offering.courseId } }, title: '另一期开课', status: 'ACTIVE',
    term: { create: { slug: randomUUID(), name: '测试春季学期', startDate: new Date('2026-02-01'), endDate: new Date('2026-06-01') } },
    members: { create: { userId: teacher, role: 'TEACHER' } },
  } });
  const legacy = await db.post.create({ data: {
    slug: randomUUID(), offeringId: offering.id, authorId: teacher, type: 'NEWS', status: 'PUBLISHED', visibility: 'PUBLIC',
    title: '原先的工作坊报道', excerpt: '旧报道摘要。', body: '旧报道正文。', publishedAt: new Date('2025-10-01'),
  } });
  const report = { title: '本期新报道', excerpt: '新报道摘要。', body: '新报道正文。', coverAlt: '', coverCaption: '' };
  await assert.rejects(saveCourseNewsDraft(student, offering.id, null, randomUUID(), report), DomainError);
  const { id, slug, revision } = await saveCourseNewsDraft(teacher, offering.id, null, randomUUID(), report);
  const target = { postId: id, revision };
  assert.equal(await getCourseNews(teacher, other.id, id), null);
  await assert.rejects(saveCourseNewsDraft(teacher, other.id, target, randomUUID(), report), DomainError);
  await assert.rejects(publishCourseNews(teacher, other.id, id, revision), DomainError);
  await assert.rejects(publishCourseNews(student, offering.id, id, revision), DomainError);
  assert.equal(await getPublishedPost(slug), null);

  const previous = await getPublishedPost(legacy.slug);
  assert.ok(previous);
  assert.deepEqual([previous.slug, previous.title, previous.excerpt, previous.body, previous.publishedAt],
    [legacy.slug, legacy.title, legacy.excerpt, legacy.body, legacy.publishedAt]);
  assert.equal(previous.publishedCover, null);
  assert.equal(previous.useLegacyCover, true);
  assert.deepEqual(await getPublicOfferingNews(offering.id), [{ slug: legacy.slug, title: legacy.title, publishedAt: legacy.publishedAt }]);
});
