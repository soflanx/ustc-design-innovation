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

/** Public homepage news, scoped to the featured course or explicitly unbound posts. */
export async function getPublicCourseNews(courseId?: string) {
  const news = await db.post.findMany({
    where: {
      ...publishedWhere,
      publishedAt: { lte: new Date() },
      type: 'NEWS',
      OR: courseId ? [{ offering: { courseId } }, { offeringId: null }] : [{ offeringId: null }],
    },
    include: { offering: { select: { title: true } } },
    orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
    take: 6,
  });
  return news.map(post => ({ ...post, category: post.type, offeringLabel: post.offering?.title ?? null }));
}

export async function getPublishedPost(slug: string) {
  const post = await db.post.findFirst({
    where: { ...publishedWhere, publishedAt: { lte: new Date() }, slug },
    include: { offering: { select: { title: true } } },
  });
  return post ? { ...post, category: post.type, offeringLabel: post.offering?.title ?? null } : null;
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
