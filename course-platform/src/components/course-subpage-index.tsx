import Link from 'next/link';
import type { CourseSubpageSummary } from '@/lib/course-subpages';
import styles from './course-subpages.module.css';

export function CourseSubpageIndex({ offeringId, pages, canReadRecords }: {
  offeringId: string; pages: CourseSubpageSummary[]; canReadRecords: boolean;
}) {
  if (!pages.length) return <p className="field-help">暂无课次。</p>;
  const base = `/courses/${encodeURIComponent(offeringId)}/pages`;
  return <ul className={styles.index} data-course-subpages>{pages.map(page => {
    const href = `${base}/${encodeURIComponent(page.id)}`;
    const title = page.publishedTitle ?? page.title;
    return <li key={page.id}>
      <div className={styles.listTitle}><Link href={href}>{title}</Link>
        {page.hasDraft && <small>{page.publishedAt ? '有未发布修改' : '草稿'}</small>}
      </div>
      {canReadRecords && <Link className={styles.recordLink} href={`${href}?view=records`} prefetch={false} aria-label={`${title}的课堂记录`}>课堂记录</Link>}
    </li>;
  })}</ul>;
}
