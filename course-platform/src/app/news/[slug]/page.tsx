import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageShell } from '@/components/site-shell';
import { getCurrentUser } from '@/lib/auth';
import { getPublishedPost } from '@/lib/queries';
import { getPostImage } from '@/lib/editorial-images';
import { getProjectDemo } from '@/lib/public-project-demo';
import { displayDate } from '@/lib/policy';
import styles from '../article.module.css';

export const dynamic = 'force-dynamic';

export default async function PostPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const { slug } = await params;
  const [post, user, { from }] = await Promise.all([getPublishedPost(slug), getCurrentUser(), searchParams]);
  if (!post) notFound();
  const image = getPostImage(post.slug);
  const demo = post.category === 'PROJECT' ? getProjectDemo(post.slug) : undefined;
  const { offering } = post;
  const backToCourse = post.category === 'NEWS' && offering && from === offering.id
    ? `/courses/${encodeURIComponent(offering.id)}?view=public#course-reports`
    : null;
  const continueExploring = post.category === 'PROJECT' && <section className={styles.continue} aria-labelledby="continue-exploring-title">
    <h2 id="continue-exploring-title">继续探索</h2>
    <nav aria-label="继续探索"><Link href="/">返回首页 →</Link><Link href={offering ? `/courses/${offering.id}` : '/courses'}>{offering ? '查看所属学期公开信息' : '查看课程公开信息'} →</Link></nav>
  </section>;
  if (demo) {
    return <PageShell currentUser={user}><article className={`container ${styles.project}`} data-project-demo={post.slug}>
      <Link className={styles.back} href="/">← 返回首页</Link>
      <header className={styles.header}>
        <p className={styles.eyebrow}>项目示例 · 非真实学生记录</p>
        <h1>{post.title}</h1>
        <p className={styles.question}>{demo.question}</p>
        <dl className={styles.facts}>
          <div><dt>关注的人</dt><dd>{demo.audience}</dd></div>
          <div><dt>示例尝试</dt><dd>{demo.attempt}</dd></div>
        </dl>
      </header>
      {image && <figure className={styles.figure}><img src={image.src} alt={image.alt} width={image.width} height={image.height}/><figcaption>{image.caption}</figcaption></figure>}
      <div className={styles.reading}>
        <section className={styles.setting} aria-labelledby="practice-setting-title">
          <h2 id="practice-setting-title">练习设定</h2>
          <p>{demo.introduction}</p>
          <p className={styles.exampleNote}>以下过程是练习建议，这里未提供真实访谈、路线测试或效果评估记录。</p>
        </section>
        <ol className={styles.steps} aria-label="建议的练习过程">{demo.steps.map(step => <li key={step.title}><section><h3>{step.title}</h3><p>{step.body}</p></section></li>)}</ol>
        <section className={styles.nextQuestion} aria-labelledby="next-question-title">
          <p>继续追问</p>
          <h2 id="next-question-title">{demo.nextQuestion}</h2>
          <p>可以从一个分岔节点开始，画出不同的提示方式，再通过实际使用来讨论和调整。</p>
        </section>
        {continueExploring}
      </div>
    </article></PageShell>;
  }
  return <PageShell currentUser={user}><article className="container section article-page">
    <Link className="breadcrumb" href={backToCourse ?? (post.category === 'PROJECT' ? '/' : { pathname: '/', query: { news: `/news/${post.slug}` }, hash: 'news' })}>← {backToCourse ? '返回开课信息' : post.category === 'PROJECT' ? '返回首页' : '返回新闻'}</Link>
    <header className="article-header">
      <p className="muted">{post.category === 'PROJECT' ? '项目专题' : '课程新闻'}{offering && <> · {post.category === 'NEWS' ? <Link href={`/courses/${offering.id}`}>{offering.title}</Link> : offering.title}</>}</p>
      <h1>{post.title}</h1>
      <p className="article-excerpt">{post.excerpt}</p>
      {post.publishedAt && <time className="muted" dateTime={post.publishedAt.toISOString()}>{displayDate(post.publishedAt)}</time>}
    </header>
    {image && <figure className="article-figure"><img src={image.src} alt={image.alt} width={image.width} height={image.height}/><figcaption>{image.caption}</figcaption></figure>}
    <div className="article-body">{post.body.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
    {continueExploring}
  </article></PageShell>;
}
