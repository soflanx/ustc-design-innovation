import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { CourseFrame } from '@/components/course-frame';
import { CourseNewsEditor } from '@/components/course-news-editor';
import styles from '@/components/course-news.module.css';
import { NewsArticle } from '@/components/news-article';
import { requireOfferingAccess } from '@/lib/access';
import { offeringCourseTitle } from '@/lib/course-label';
import { courseNewsHref, getCourseNews } from '@/lib/course-news';
import { publishCourseNewsAction, withdrawCourseNewsAction } from '@/lib/course-news-actions';
import { getPostImage } from '@/lib/editorial-images';
import { isActiveTeachingMember } from '@/lib/policy';

export default async function CourseNewsDetailPage({ params, searchParams }: {
  params: Promise<{ offeringId: string; postId: string }>;
  searchParams: Promise<{ edit?: string | string[] }>;
}) {
  const [{ offeringId, postId }, query] = await Promise.all([params, searchParams]);
  const base = courseNewsHref(offeringId);
  const href = courseNewsHref(offeringId, postId);
  const creating = postId === 'new';
  const wantsEdit = query.edit === '1';
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, wantsEdit ? `${href}?edit=1` : href);
  if (!isActiveTeachingMember(membership)) notFound();
  const archived = offering.status === 'ARCHIVED';
  const post = creating ? null : await getCourseNews(user.id, offeringId, postId);
  if (!post && (!creating || archived)) notFound();

  const editHref = `${href}?edit=1`;
  const back = <Link className="breadcrumb" href={base}>← 返回课程新闻</Link>;
  const draft = post?.draft;
  const cover = draft?.cover ? { ...draft.cover, src: `${href}/cover/${encodeURIComponent(draft.cover.id)}` }
    : draft?.useLegacyCover && post ? getPostImage(post.slug) : undefined;
  const isPublic = post?.isPublic ?? false;
  const hasChanges = post?.hasUnpublishedChanges ?? false;
  const status = isPublic ? (hasChanges ? '已公开 · 有未发布修改' : '已公开')
    : post?.status === 'ARCHIVED' ? '已撤回' : '草稿';

  if (!post || (wantsEdit && !archived)) {
    return <CourseFrame user={user} offering={offering} membership={membership} active="news">
      <div className={styles.workspace}>
        <div className={styles.tools}>
          {back}
          {post && <Link href={href}>预览已保存稿</Link>}
        </div>
        <header className={styles.heading}><h1>{post ? '编辑新闻' : '新建新闻'}</h1></header>
        <p className="field-help">保存的草稿仅本期教学团队可见。</p>
        <CourseNewsEditor key={JSON.stringify([user.id, offeringId, postId])} viewerId={user.id} offeringId={offeringId}
          target={post ? { postId: post.id, revision: post.revision } : null} requestId={randomUUID()}
          initial={draft ? { title: draft.title, excerpt: draft.excerpt, body: draft.body } : { title: '', excerpt: '', body: '' }}
          cover={cover && { ...cover, legacy: !draft?.cover }} latestHref={post ? editHref : base}/>
      </div>
    </CourseFrame>;
  }

  const needsPublication = !isPublic || hasChanges;
  const hasBody = Boolean(post.draft.body.trim());
  const active = offering.status === 'ACTIVE';
  const canPublish = needsPublication && active && hasBody;
  return <CourseFrame user={user} offering={offering} membership={membership} active="news">
    <div className={styles.workspace}>
      <div className={styles.tools}>
        {back}
        {!archived && <Link href={editHref}>编辑新闻</Link>}
      </div>
      <div className={styles.status}>
        <span role="status">{status}</span>
        {isPublic && <a href={`/news/${encodeURIComponent(post.slug)}`} target="_blank" rel="noopener noreferrer">查看公开新闻 ↗</a>}
      </div>
      <article className={styles.preview} aria-label={needsPublication ? '新闻草稿预览' : '新闻预览'}>
        <NewsArticle title={post.draft.title} excerpt={post.draft.excerpt} body={post.draft.body}
          offeringLabel={offeringCourseTitle(offering)} publishedAt={isPublic && !hasChanges ? post.publishedAt : null} cover={cover}/>
        {!hasBody && <p className="field-help">正文尚未填写。</p>}
      </article>
      {(!archived || isPublic) && <section className={styles.release} aria-labelledby="news-release-heading">
        <h2 id="news-release-heading">公开发布</h2>
        {offering.status === 'DRAFT' && <p className="field-help">课程正在筹备。开课后可发布新闻。</p>}
        {needsPublication && active && !hasBody && <p className="field-help">请先编辑并保存正文。</p>}
        {canPublish && <details key={`publish-${user.id}-${post.revision}`}>
          <summary>{isPublic ? '更新公开新闻' : '发布到互联网'}</summary>
          <ActionForm action={publishCourseNewsAction.bind(null, offeringId, user.id, post.id, post.revision)}
            submitLabel={isPublic ? '确认更新公开新闻' : '确认公开发布'}>
            <p className="field-help">确认后，访客可从新闻目录和本期开课页阅读预览中的正文和配图。</p>
          </ActionForm>
        </details>}
        {isPublic && <details key={`withdraw-${user.id}-${post.revision}-${post.publishedRevision}`}>
          <summary>撤回公开新闻</summary>
          <ActionForm action={withdrawCourseNewsAction.bind(null, offeringId, user.id, post.id, post.revision, post.publishedRevision)} submitLabel="确认撤回">
            <p className="field-help">撤回后，访客无法通过新闻目录、开课页或原链接阅读此文和配图。</p>
          </ActionForm>
        </details>}
      </section>}
    </div>
  </CourseFrame>;
}
