import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageShell } from '@/components/site-shell';
import { getCurrentUser } from '@/lib/auth';
import { stories } from '@/lib/home-editorial';
import styles from '../../editorial-record.module.css';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const story = stories.find(item => item.slug === slug);
  return { title: story ? story.title : '故事未找到' };
}

export default async function StoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const storyIndex = stories.findIndex(item => item.slug === slug);
  const story = stories[storyIndex];
  if (!story) notFound();
  const user = await getCurrentUser();
  const next = stories[(storyIndex + 1) % stories.length];

  return <PageShell currentUser={user}><article className={styles.record}>
    <Link className={styles.back} href="/stories">← 全部故事</Link>
    <header className={styles.header}>
      <p className={styles.meta}><span>{story.category}</span><span>{story.kicker}</span><span>展示样稿</span></p>
      <h1>{story.title}</h1>
      <p className={styles.excerpt}>{story.excerpt}</p>
    </header>
    {story.image && <figure className={styles.figure}><img src={story.image.src} alt={story.image.alt} width={story.image.width} height={story.image.height} style={{ objectPosition: story.imagePosition }}/><figcaption>{story.image.caption}</figcaption></figure>}
    <div className={styles.body}>
      <p className={styles.note}>故事展示样稿：下文为虚构叙事，用于展示人物经历与项目过程；图片仅作场景示意。</p>
      {story.sections.map(section => <section className={styles.section} key={section.title}><h2>{section.title}</h2><p>{section.body}</p></section>)}
      <p className={styles.takeaway}>{story.takeaway}</p>
      <nav className={styles.continue} aria-label="继续浏览"><Link href="/#stories">返回首页故事 ↗</Link><Link href="/courses">了解课程与学期 →</Link></nav>
    </div>
    {next && <aside className={styles.next}><p>下一篇 · {next.category}</p><Link href={`/stories/${next.slug}`}>{next.title}<span aria-hidden="true">→</span></Link></aside>}
  </article></PageShell>;
}
