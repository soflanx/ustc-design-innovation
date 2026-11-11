import Link from 'next/link';
import { PageShell } from '@/components/site-shell';
import { getCurrentUser } from '@/lib/auth';
import { stories } from '@/lib/home-editorial';
import styles from './stories.module.css';

export const metadata = {
  title: '故事',
  description: '阅读课程中的人物经历、项目过程与设计思考。',
};

export default async function StoriesPage() {
  const user = await getCurrentUser();
  return <PageShell currentUser={user}><div className={styles.page}>
    <Link className={styles.back} href="/#stories">← 返回首页故事</Link>
    <header className={styles.header}>
      <h1>故事</h1>
      <p>记录课程中的人物经历、项目过程与设计思考。</p>
    </header>
    <div className={styles.sectionMeta}><p>全部故事 <span>{stories.length}</span></p></div>
    {!stories.length && <p className="empty-state">暂无已发布故事。</p>}
    <div className={styles.grid}>
      {stories.map(story => <article className={styles.story} key={story.slug}>
        <Link className={styles.card} href={`/stories/${story.slug}`} aria-labelledby={`story-${story.slug}`}>
          {story.image && <div className={styles.image}><img src={story.image.src} alt={story.image.alt} width={story.image.width} height={story.image.height} style={{ objectPosition: story.imagePosition }}/></div>}
          <div className={styles.copy}>
            <p className={styles.category}>{story.category}</p>
            <h2 id={`story-${story.slug}`}>{story.title}</h2>
            <p className={styles.excerpt}>{story.excerpt}</p>
            <span className={styles.read}>阅读故事 <span aria-hidden="true">↗</span></span>
          </div>
        </Link>
      </article>)}
    </div>
  </div></PageShell>;
}
