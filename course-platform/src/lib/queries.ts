import type { Prisma } from '@prisma/client';
import { db } from './db';

export function publicPostVisibility(now = new Date()): Prisma.PostWhereInput {
  return { status: 'PUBLISHED', visibility: 'PUBLIC', publishedAt: { lte: now } };
}

/** Public reports from the courses shown on the homepage, plus unbound news. */
export function getPublicCourseNews(courseIds: readonly string[]) {
  return db.post.findMany({
    where: {
      ...publicPostVisibility(),
      type: 'NEWS',
      OR: [{ offering: { courseId: { in: [...courseIds] } } }, { offeringId: null }],
    },
    select: { slug: true, title: true, publishedAt: true },
    orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
    take: 6,
  });
}

/** Every public news report, newest first, for the news index. */
export function getPublicNews() {
  return db.post.findMany({
    where: { ...publicPostVisibility(), type: 'NEWS' },
    select: { slug: true, title: true, excerpt: true, publishedAt: true },
    orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
  });
}

export function getPublicOfferingNews(offeringId: string) {
  return db.post.findMany({
    where: {
      ...publicPostVisibility(),
      type: 'NEWS',
      offeringId,
      offering: { status: { in: ['ACTIVE', 'ARCHIVED'] } },
    },
    select: { slug: true, title: true, publishedAt: true },
    orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
  });
}

export async function getPublishedPost(slug: string) {
  const post = await db.post.findFirst({
    where: { ...publicPostVisibility(), slug },
    select: {
      slug: true, type: true, title: true, excerpt: true, body: true, publishedAt: true, publishedRevision: true, useLegacyCover: true,
      publishedCover: { select: { id: true, alt: true, caption: true, width: true, height: true } },
      offering: {
        where: { status: { in: ['ACTIVE', 'ARCHIVED'] } },
        select: { id: true, title: true },
      },
    },
  });
  return post ? { ...post, category: post.type } : null;
}

export function getPublishedNewsCover(slug: string, imageId: string) {
  return db.newsImage.findFirst({
    where: {
      id: imageId,
      publicSlot: { is: { ...publicPostVisibility(), slug, type: 'NEWS', publishedRevision: { not: null } } },
    },
    select: { bytes: true, contentType: true },
  });
}

/** Existing editorial project articles retain their published archive. */
export function getLegacyPublicProjects() {
  return db.post.findMany({
    where: { ...publicPostVisibility(), type: 'PROJECT' },
    select: { slug: true, title: true, excerpt: true },
    orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
  });
}

export function getPublicCourses() {
  return db.course.findMany({
    orderBy: { title: 'asc' },
    include: {
      offerings: {
        where: { status: { in: ['ACTIVE', 'ARCHIVED'] } },
        include: { term: true },
        orderBy: { term: { startDate: 'desc' } },
      },
    },
  });
}

export function getMyMemberships(userId: string) {
  return db.courseMember.findMany({
    where: { userId, status: 'ACTIVE' },
    include: { offering: { include: { course: true, term: true } } },
    orderBy: { offering: { term: { startDate: 'desc' } } },
  });
}
