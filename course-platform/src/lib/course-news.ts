import { createHash } from 'node:crypto';
import { Prisma, type MemberRole, type TermStatus } from '@prisma/client';
import sharp from 'sharp';
import { z } from 'zod';
import { db } from './db';
import { DomainError } from './management';
import { isActiveTeachingMember } from './policy';
import { readResourceUpload } from './resource-file';
import { inlineFile } from './resource-preview';

type Tx = Prisma.TransactionClient;
type NewsTarget = { postId: string; revision: number };
type NewsDraftInput = {
  title: string; excerpt: string; body: string; coverAlt: string; coverCaption: string;
  cover?: File; removeCover?: boolean;
};
const coverLimit = 5 * 1024 * 1024;
const draftValues = z.object({
  title: z.string().trim().min(1, '请填写新闻标题。').max(120, '新闻标题最多 120 字。'),
  excerpt: z.string().trim().max(300, '摘要最多 300 字。'),
  body: z.string().trim().max(12000, '正文最多 12000 字。'),
  coverAlt: z.string().trim().max(180, '图片描述最多 180 字。'),
  coverCaption: z.string().trim().max(180, '图注最多 180 字。'),
});
const coverMeta = { id: true, alt: true, caption: true, width: true, height: true } as const;
const draftSelect = {
  title: true, excerpt: true, body: true, useLegacyCover: true, cover: { select: coverMeta },
} as const;
const newsSelect = {
  id: true, slug: true, title: true, excerpt: true, body: true, status: true, visibility: true, publishedAt: true,
  revision: true, publishedRevision: true, useLegacyCover: true, publishedCover: { select: coverMeta },
  draft: { select: draftSelect },
} as const satisfies Prisma.PostSelect;
const newsReceipt = { id: true, slug: true, revision: true } as const;
const imageContent = { bytes: true, contentType: true } as const;

export function courseNewsHref(offeringId: string, postId?: string) {
  const base = `/courses/${encodeURIComponent(offeringId)}/news`;
  return postId === undefined ? base : `${base}/${encodeURIComponent(postId)}`;
}

function courseNewsScope(userId: string, offeringId: string): Prisma.PostWhereInput {
  return { offeringId, type: 'NEWS', offering: { members: { some: { userId, status: 'ACTIVE', role: { in: ['TEACHER', 'TA'] } } } } };
}

function newsListing(post: {
  id: string; slug: string; title: string; status: string; visibility: string; publishedAt: Date | null;
  revision: number; publishedRevision: number | null; draft: { title: string } | null;
}) {
  return {
    id: post.id, slug: post.slug, title: post.draft?.title ?? post.title, status: post.status,
    publishedAt: post.publishedAt, publishedRevision: post.publishedRevision,
    isPublic: post.status === 'PUBLISHED' && post.visibility === 'PUBLIC' && post.publishedAt !== null && post.publishedAt <= new Date(),
    hasUnpublishedChanges: post.draft !== null && post.revision !== post.publishedRevision,
  };
}

export async function listCourseNews(userId: string, offeringId: string) {
  const posts = await db.post.findMany({
    where: courseNewsScope(userId, offeringId),
    select: { ...newsReceipt, title: true, status: true, visibility: true, publishedAt: true, publishedRevision: true, draft: { select: { title: true } } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
  });
  return posts.map(newsListing);
}

export async function getCourseNews(userId: string, offeringId: string, postId: string) {
  const post = await db.post.findFirst({ where: { id: postId, ...courseNewsScope(userId, offeringId) }, select: newsSelect });
  if (!post) return null;
  return { ...newsListing(post), revision: post.revision, draft: post.draft ?? {
    title: post.title, excerpt: post.excerpt, body: post.body, useLegacyCover: post.useLegacyCover, cover: post.publishedCover,
  } };
}

export function getCourseNewsDraftCover(userId: string, offeringId: string, postId: string, imageId: string) {
  const post = courseNewsScope(userId, offeringId);
  return db.newsImage.findFirst({
    where: { id: imageId, postId, OR: [
      { draftSlot: { is: { post } } },
      { publicSlot: { is: { ...post, draft: { is: null } } } },
    ] },
    select: imageContent,
  });
}

async function lockNewsWriter(tx: Tx, userId: string, offeringId: string, operation: 'save' | 'publish' | 'withdraw') {
  const [offering] = await tx.$queryRaw<{ status: TermStatus }[]>`
    SELECT "status" FROM "CourseOffering" WHERE "id" = ${offeringId} FOR SHARE
  `;
  const [member] = await tx.$queryRaw<{ role: MemberRole }[]>`
    SELECT "role" FROM "CourseMember"
    WHERE "userId" = ${userId} AND "offeringId" = ${offeringId} AND "status" = 'ACTIVE'
    FOR SHARE
  `;
  if (!offering || (member?.role !== 'TEACHER' && member?.role !== 'TA')) {
    throw new DomainError('只有本期教学团队可以操作课程新闻。');
  }
  if (operation === 'publish' && offering.status !== 'ACTIVE') throw new DomainError('进行中的课程才可发布新闻。');
  if (operation === 'save' && offering.status === 'ARCHIVED') throw new DomainError('该学期已归档，新闻草稿只供查看。');
}

async function lockCourseNews(tx: Tx, offeringId: string, postId: string) {
  const [record] = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Post" WHERE "id" = ${postId} AND "offeringId" = ${offeringId} AND "type" = 'NEWS'
    FOR NO KEY UPDATE
  `;
  if (!record) throw new DomainError('新闻不存在或不属于本期开课。');
  return tx.post.findUniqueOrThrow({ where: { id: record.id }, select: newsSelect });
}

function checkRevision(actual: number, expected: number) {
  if (actual !== expected || !Number.isSafeInteger(expected) || expected < 0) {
    throw new DomainError('新闻已更新，请对照最新草稿再继续。当前输入已保留。');
  }
}

async function readCover(file: File) {
  if (file.size > coverLimit) throw new DomainError('配图不能超过 5 MiB。');
  const upload = await readResourceUpload(file);
  const format = upload ? inlineFile(upload.name, upload.bytes)?.contentType : undefined;
  if (!upload || (format !== 'image/jpeg' && format !== 'image/png' && format !== 'image/webp')) {
    throw new DomainError('请选择有效的 JPEG、PNG 或 WebP 图片。');
  }
  try {
    // Orient the pixels before resizing; the WebP output leaves out photo metadata.
    const { data, info } = await sharp(upload.bytes, { limitInputPixels: 32_000_000, failOn: 'error' })
      .autoOrient().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
    return {
      image: { bytes: new Uint8Array(data), contentType: 'image/webp', width: info.width, height: info.height },
      digest: createHash('sha256').update(upload.bytes).digest('hex'),
    };
  } catch {
    throw new DomainError('这张图片无法读取或尺寸过大。请导出较小的图片后重新选择。');
  }
}

async function removeUnusedNewsImages(tx: Tx, postId: string) {
  await tx.newsImage.deleteMany({ where: { postId, publicSlot: { is: null }, draftSlot: { is: null } } });
}

export async function saveCourseNewsDraft(userId: string, offeringId: string, target: NewsTarget | null, requestId: string, input: NewsDraftInput) {
  const { coverAlt, coverCaption, ...values } = draftValues.parse(input);
  if (input.cover && input.removeCover) throw new DomainError('请选择替换配图或移除配图。');
  if (!target && !z.uuid().safeParse(requestId).success) throw new DomainError('请从课程新闻重新打开新建表单。');
  if (input.cover && !coverAlt) throw new DomainError('请简短描述图片，方便无法看到图片的读者。');
  if (input.cover) {
    const member = await db.courseMember.findUnique({ where: { offeringId_userId: { offeringId, userId } },
      select: { role: true, status: true, offering: { select: { status: true } } } });
    if (!member || !isActiveTeachingMember(member)) throw new DomainError('只有本期教学团队可以操作课程新闻。');
    if (member.offering.status === 'ARCHIVED') throw new DomainError('该学期已归档，新闻草稿只供查看。');
  }
  const upload = input.cover ? await readCover(input.cover) : null;

  return db.$transaction(async tx => {
    await lockNewsWriter(tx, userId, offeringId, 'save');
    let postId: string;
    let currentCover: { id: string; alt: string; caption: string } | null = null;
    let useLegacyCover = false;
    if (target) {
      const post = await lockCourseNews(tx, offeringId, target.postId);
      checkRevision(post.revision, target.revision);
      postId = post.id;
      currentCover = post.draft ? post.draft.cover : post.publishedCover;
      useLegacyCover = post.draft?.useLegacyCover ?? post.useLegacyCover;
      await tx.post.update({ where: { id: postId }, data: { revision: { increment: 1 } }, select: { id: true } });
    } else {
      postId = requestId.toLowerCase();
      const fingerprint = createHash('sha256').update(JSON.stringify({
        values, image: upload ? [upload.digest, coverAlt, coverCaption] : null,
      })).digest('hex');
      const created = await tx.post.createMany({
        data: { id: postId, offeringId, authorId: userId, slug: `news-${postId}`, type: 'NEWS',
          title: '', body: '', revision: 1, creationFingerprint: fingerprint, useLegacyCover: false },
        skipDuplicates: true,
      });
      if (!created.count) {
        const original = await tx.post.findFirst({
          where: { id: postId, offeringId, authorId: userId, type: 'NEWS', creationFingerprint: fingerprint },
          select: newsReceipt,
        });
        if (!original) throw new DomainError('创建标识已使用，请重新打开新建表单。');
        return original;
      }
    }

    let coverId = currentCover?.id ?? null;
    if (upload) {
      const cover = await tx.newsImage.create({
        data: { ...upload.image, postId, alt: coverAlt, caption: coverCaption }, select: { id: true },
      });
      coverId = cover.id;
      useLegacyCover = false;
    } else if (input.removeCover) {
      coverId = null;
      useLegacyCover = false;
    } else if (currentCover && (currentCover.alt !== coverAlt || currentCover.caption !== coverCaption)) {
      if (!coverAlt) throw new DomainError('请简短描述图片，方便无法看到图片的读者。');
      const image = await tx.newsImage.findUniqueOrThrow({
        where: { id: currentCover.id }, select: { ...imageContent, width: true, height: true },
      });
      const cover = await tx.newsImage.create({ data: { ...image, postId, alt: coverAlt, caption: coverCaption }, select: { id: true } });
      coverId = cover.id;
    }
    const draft = { ...values, useLegacyCover, coverId };
    await tx.postNewsDraft.upsert({ where: { postId }, create: { postId, ...draft }, update: draft, select: { postId: true } });
    await removeUnusedNewsImages(tx, postId);
    return tx.post.findUniqueOrThrow({ where: { id: postId }, select: newsReceipt });
  });
}

export async function publishCourseNews(userId: string, offeringId: string, postId: string, revision: number) {
  return db.$transaction(async tx => {
    await lockNewsWriter(tx, userId, offeringId, 'publish');
    const post = await lockCourseNews(tx, offeringId, postId);
    checkRevision(post.revision, revision);
    if (newsListing(post).isPublic && post.publishedRevision === revision) return post.slug;
    const draft = post.draft ?? post;
    if (!draft.title.trim() || !draft.body.trim()) throw new DomainError('请填写标题和正文，再预览并确认发布。');
    const coverId = post.draft ? post.draft.cover?.id : post.publishedCover?.id;
    const now = new Date();
    await tx.post.update({ where: { id: postId }, data: {
      title: draft.title, excerpt: draft.excerpt, body: draft.body,
      useLegacyCover: draft.useLegacyCover, publishedCoverId: coverId ?? null, publishedRevision: revision,
      status: 'PUBLISHED', visibility: 'PUBLIC', publishedAt: post.publishedAt && post.publishedAt <= now ? post.publishedAt : now,
    }, select: { id: true } });
    await removeUnusedNewsImages(tx, postId);
    return post.slug;
  });
}

export async function withdrawCourseNews(userId: string, offeringId: string, postId: string, revision: number, publishedRevision: number | null) {
  return db.$transaction(async tx => {
    await lockNewsWriter(tx, userId, offeringId, 'withdraw');
    const post = await lockCourseNews(tx, offeringId, postId);
    if (post.publishedRevision !== publishedRevision) throw new DomainError('公开新闻已有更新，请查看后再确认撤回。');
    if (post.status === 'ARCHIVED' && Number.isSafeInteger(revision) && revision >= 0 && post.revision === revision + 1) return post.slug;
    checkRevision(post.revision, revision);
    if (!newsListing(post).isPublic) throw new DomainError('这篇新闻当前没有对外发布。');
    await tx.post.update({ where: { id: postId }, data: { status: 'ARCHIVED', revision: { increment: 1 } }, select: { id: true } });
    return post.slug;
  });
}
