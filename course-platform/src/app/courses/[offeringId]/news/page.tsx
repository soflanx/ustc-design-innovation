import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CourseFrame } from '@/components/course-frame';
import styles from '@/components/course-news.module.css';
import { requireOfferingAccess } from '@/lib/access';
import { courseNewsHref, listCourseNews } from '@/lib/course-news';
import { displayDate, isActiveTeachingMember } from '@/lib/policy';

export default async function CourseNewsPage({ params }: { params: Promise<{ offeringId: string }> }) {
  const { offeringId } = await params;
  const base = courseNewsHref(offeringId);
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, base);
  if (!isActiveTeachingMember(membership)) notFound();
  const posts = await listCourseNews(user.id, offeringId);
  const archived = offering.status === 'ARCHIVED';

  return <CourseFrame user={user} offering={offering} membership={membership} active="news">
    <div className={styles.workspace}>
      <header className={styles.heading}>
        <h1>课程新闻</h1>
        {!archived && <Link className="button primary" href={`${base}/new`} prefetch={false}>新建新闻</Link>}
      </header>
      {archived && <p className="field-help">本学期已归档。已公开的新闻仍可撤回。</p>}
      {posts.length === 0 ? <p className="empty-state">本学期暂无新闻。</p> : <ul className={styles.posts}>
        {posts.map(post => {
          const status = post.isPublic ? (post.hasUnpublishedChanges ? '已公开 · 有未发布修改' : '已公开')
            : post.status === 'ARCHIVED' ? '已撤回' : '草稿';
          return <li key={post.id}>
            <Link className={styles.post} href={`${base}/${encodeURIComponent(post.id)}`} prefetch={false}>
              <h2>{post.title}</h2>
              <span className={styles.meta}>{status}{post.isPublic && post.publishedAt && <>
                {' · '}<time dateTime={post.publishedAt.toISOString()}>发布于 {displayDate(post.publishedAt)}</time>
              </>}</span>
            </Link>
          </li>;
        })}
      </ul>}
    </div>
  </CourseFrame>;
}
