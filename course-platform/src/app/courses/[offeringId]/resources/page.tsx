import Link from 'next/link';
import { requireOfferingAccess } from '@/lib/access';
import { resourceReference } from '@/lib/course-record-catalog';
import { getCourseResources } from '@/lib/resource-service';
import { CourseContentIcon } from '@/components/course-content-icon';
import { CourseFrame } from '@/components/course-frame';
import { ResourceForm } from '@/components/resource-fields';
import styles from '@/app/resources.module.css';

const statusLabels: Record<string, string> = { DRAFT: '草稿', PUBLISHED: '已发布', ARCHIVED: '已撤回' };

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function ResourcesPage({ params, searchParams }: { params: Promise<{ offeringId: string }>; searchParams: Promise<{ q?: string }> }) {
  const { offeringId } = await params;
  const query = (await searchParams).q;
  const search = typeof query === 'string' ? query.trim().slice(0, 100) : '';
  const base = `/courses/${encodeURIComponent(offeringId)}/resources`;
  const returnTo = base + (search ? `?${new URLSearchParams({ q: search })}` : '');
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, returnTo);
  const { resources, canManage } = await getCourseResources(user.id, offeringId);
  const term = search.toLocaleLowerCase();
  const matches = resources.filter(resource => [resource.title, resource.file?.name, resource.body].some(value => value?.toLocaleLowerCase().includes(term)));
  const archived = offering.status === 'ARCHIVED';
  const canEdit = canManage && !archived;
  const editQuery = new URLSearchParams({ edit: '1' });
  if (search) editQuery.set('q', search);

  return <CourseFrame user={user} offering={offering} membership={membership} active="resources"><div className={styles.page}>
    <header className={styles.heading}><h1>课程资料</h1>
      {canEdit && <details className={styles.upload}><summary><CourseContentIcon name="plus" size={16}/>添加资料</summary>
        <div className={styles.formBody}><ResourceForm offeringId={offeringId}/></div>
      </details>}
    </header>
    {archived && <p className={styles.notice}>本学期已归档，课程资料保持只读。</p>}
    <form action={base} method="get" className={styles.search} role="search">
      <label className="sr-only" htmlFor="resource-search">搜索课程资料</label>
      <input id="resource-search" type="search" name="q" defaultValue={search} placeholder="搜索标题、文件名或说明" maxLength={100}/>
      <button className="button" type="submit">搜索</button>
      {search && <Link href={base}>清除</Link>}
    </form>
    {search && <p className={styles.searchCount}>“{search}” · {matches.length} 项结果</p>}
    <section className={styles.list} aria-label="课程资料">
      {matches.length ? matches.map(resource => {
        const { href, actionLabel, opensInNewTab, resourceFormat } = resourceReference(resource);
        const { file, url } = resource;
        const host = url && URL.canParse(url) ? new URL(url).hostname : null;
        const facts = [resourceFormat, file?.name !== resource.title ? file?.name : null, file ? fileSize(file.size) : host,
          canManage ? statusLabels[resource.status] : null].filter(Boolean);
        return <article className={styles.row} key={resource.id}>
          <CourseContentIcon name={!file && url ? 'link' : 'resource'} size={22} className={styles.icon}/>
          <div className={styles.info}>
            <h2><a href={href} target={opensInNewTab ? '_blank' : undefined} rel={opensInNewTab ? 'noopener noreferrer' : undefined}
              title={actionLabel} aria-label={`${resource.title}，${actionLabel}${opensInNewTab ? '（新标签页）' : ''}`}>{resource.title}</a></h2>
            <p className={styles.meta}>{facts.join(' · ')}</p>
            {(file || url) && resource.body && <details className={styles.description}><summary>资料说明</summary><p>{resource.body}</p></details>}
          </div>
          <div className={styles.actions}>
            {file && resourceFormat === 'PDF' && <a href={href + '?download=1'}>下载</a>}
            {canEdit && <Link href={`${base}/${encodeURIComponent(resource.id)}?${editQuery}`}>编辑</Link>}
          </div>
        </article>;
      }) : <p className={styles.empty}>{search ? '没有找到匹配资料，请换一个关键词。' : canManage ? '本学期尚未添加资料。' : '暂无已发布的课程资料。'}</p>}
    </section>
  </div></CourseFrame>;
}
