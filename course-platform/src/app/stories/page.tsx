import Link from 'next/link';
import { PageShell } from '@/components/site-shell';
import { studentStories } from '@/lib/home-editorial';
import styles from './stories.module.css';

export const metadata = {
  title: '学生与小组的故事',
  description: '从个人观察到小组协作，阅读学生在设计实践中的经历与思考。',
};

export default function StoriesPage() {
  return <PageShell><div className={styles.page}>
    <Link className={styles.back} href="/#stories">← 返回首页学生记录</Link>
    <header className={styles.header}>
      <h1>学生与小组的故事</h1>
      <p>看见不同的人怎样观察、合作与尝试，也看见一个想法如何慢慢改变。</p>
    </header>
    <div className={styles.sectionMeta}><p>全部故事 <span>{studentStories.length}</span></p><span>内容展示样稿</span></div>
    <div className={styles.grid}>
      {studentStories.map(story => <article className={styles.story} key={story.slug}>
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
    <p className={styles.note}>以上为匿名故事样稿，图片仅作场景示意。</p>
  </div></PageShell>;
}
