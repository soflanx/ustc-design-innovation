import { db } from './db';

const publishedWhere = { status: 'PUBLISHED' as const, visibility: 'PUBLIC' as const, publishedAt: { lte: new Date() } };

export async function getPublishedPosts() {
  const posts = await db.post.findMany({
    where: { ...publishedWhere, publishedAt: { lte: new Date() } },
    include: { offering: { select: { title: true } } },
    orderBy: { publishedAt: 'desc' },
    take: 12,
  });
  return posts.map(post => ({ ...post, category: post.type, offeringLabel: post.offering?.title ?? null }));
}

/** Public reports from the courses shown on the homepage, plus unbound news. */
export function getPublicCourseNews(courseIds: readonly string[]) {
  return db.post.findMany({
    where: {
      ...publishedWhere,
      publishedAt: { lte: new Date() },
      type: 'NEWS',
      OR: [{ offering: { courseId: { in: [...courseIds] } } }, { offeringId: null }],
    },
    select: { slug: true, title: true, publishedAt: true },
    orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
    take: 6,
  });
}

export function getPublicOfferingNews(offeringId: string) {
  return db.post.findMany({
    where: {
      ...publishedWhere,
      publishedAt: { lte: new Date() },
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
    where: { ...publishedWhere, publishedAt: { lte: new Date() }, slug },
    select: {
      slug: true, type: true, title: true, excerpt: true, body: true, publishedAt: true,
      offering: {
        where: { status: { in: ['ACTIVE', 'ARCHIVED'] } },
        select: { id: true, title: true },
      },
    },
  });
  return post ? { ...post, category: post.type } : null;
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
