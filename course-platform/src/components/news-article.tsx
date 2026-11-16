import Link from 'next/link';
import { displayDate } from '@/lib/policy';

type NewsCover = { src: string; alt: string; caption: string; width?: number; height?: number };

export function NewsArticle({ title, excerpt, body, offeringLabel, offeringHref, publishedAt, cover }: {
  title: string;
  excerpt: string;
  body: string;
  offeringLabel?: string;
  offeringHref?: string;
  publishedAt?: Date | null;
  cover?: NewsCover;
}) {
  return <>
    <header className="article-header">
      <p className="muted">课程新闻{offeringLabel && <> · {offeringHref ? <Link href={offeringHref}>{offeringLabel}</Link> : offeringLabel}</>}</p>
      <h1>{title}</h1>
      {excerpt && <p className="article-excerpt">{excerpt}</p>}
      {publishedAt && <time className="muted" dateTime={publishedAt.toISOString()}>{displayDate(publishedAt)}</time>}
    </header>
    {cover && <figure className="article-figure">
      <img src={cover.src} alt={cover.alt} width={cover.width} height={cover.height}/>
      {cover.caption && <figcaption>{cover.caption}</figcaption>}
    </figure>}
    {body && <div className="article-body">{body.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>}
  </>;
}
