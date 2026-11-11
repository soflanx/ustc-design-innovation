import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageShell } from '@/components/site-shell';
import { getCurrentUser } from '@/lib/auth';
import { newsFeatures } from '@/lib/home-editorial';
import styles from '../../editorial-record.module.css';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const update = newsFeatures.find(item => item.slug === slug);
  return { title: update ? update.title : '新闻未找到' };
}

export default async function UpdatePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const update = newsFeatures.find(item => item.slug === slug);
  if (!update) notFound();
  const user = await getCurrentUser();

  return <PageShell currentUser={user}><article className={styles.record}>
    <Link className={styles.back} href={{ pathname: '/', query: { news: `/updates/${update.slug}` }, hash: 'news' }}>← 返回新闻</Link>
    <header className={styles.header}>
      <p className={styles.meta}><span>{update.category}</span><span>{update.kicker}</span><span>展示样稿</span></p>
      <h1>{update.title}</h1>
      <p className={styles.excerpt}>{update.excerpt}</p>
    </header>
    {update.image && <figure className={styles.figure}><img src={update.image.src} alt={update.image.alt} width={update.image.width} height={update.image.height} style={{ objectPosition: update.imagePosition }}/><figcaption>{update.image.caption}</figcaption></figure>}
    <div className={styles.body}>
      <p className={styles.note}>新闻展示样稿：下文为虚构活动报道，图片仅作场景示意。</p>
      {update.sections.map(section => <section className={styles.section} key={section.title}><h2>{section.title}</h2><p>{section.body}</p></section>)}
      <p className={styles.takeaway}>{update.takeaway}</p>
      <nav className={styles.continue} aria-label="继续浏览"><Link href="/#news">更多新闻 ↗</Link><Link href="/#stories">阅读故事 →</Link><Link href="/courses">了解课程与学期 →</Link></nav>
    </div>
  </article></PageShell>;
}
