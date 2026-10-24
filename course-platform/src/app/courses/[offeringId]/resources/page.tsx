import Link from 'next/link';
import { requireOfferingAccess } from '@/lib/access';
import { getCourseResources } from '@/lib/resource-service';
import { createResourceAction } from '@/lib/resource-actions';
import { CourseFrame } from '@/components/course-frame';
import { ActionForm } from '@/components/action-form';
import { ResourceFields } from '@/components/resource-fields';
import styles from '@/app/resources.module.css';

const statusLabels: Record<string, string> = { DRAFT: '草稿', PUBLISHED: '已发布', ARCHIVED: '已下架' };

export default async function ResourcesPage({ params, searchParams }: { params: Promise<{ offeringId: string }>; searchParams: Promise<{ q?: string }> }) {
  const { offeringId } = await params;
  const query = (await searchParams).q;
  const search = typeof query === 'string' ? query.trim().slice(0, 100) : '';
  const returnTo = `/courses/${offeringId}/resources${search ? `?${new URLSearchParams({ q: search })}` : ''}`;
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, returnTo);
  const { resources, canManage } = await getCourseResources(user.id, offeringId);
  const matches = resources.filter(resource => `${resource.title}\n${resource.body}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const searchQuery = search ? `?${new URLSearchParams({ q: search })}` : '';
  const archived = offering.status === 'ARCHIVED';
  return <CourseFrame user={user} offering={offering} membership={membership} active="resources"><div className={styles.page}>
    <header className={styles.heading}><h1>课程资料</h1></header>
    {archived && <p className={styles.notice}>本学期已归档，课程资料保持只读。</p>}
    <form action={`/courses/${offeringId}/resources`} method="get" className={styles.search} role="search"><label className="sr-only" htmlFor="resource-search">搜索课程资料</label><input id="resource-search" type="search" name="q" defaultValue={search} placeholder="搜索资料标题或正文" maxLength={100}/><button className="button" type="submit">搜索</button>{search && <Link href={`/courses/${offeringId}/resources`}>清除</Link>}</form>
    {search && <p className={styles.searchCount}>“{search}” · {matches.length} 项结果</p>}
    {canManage && !archived && <details className={styles.editor}><summary>添加资料</summary><div className={styles.editorBody}><ActionForm action={createResourceAction.bind(null, offeringId)} submitLabel="保存资料"><ResourceFields/></ActionForm></div></details>}
    <section className={styles.list} aria-label="课程资料">
      {matches.length ? matches.map(resource => <article className={styles.row} key={resource.id}>
        <div><h2><Link href={`/courses/${offeringId}/resources/${resource.id}${searchQuery}`}>{resource.title}</Link></h2><p>{resource.body || '打开资料详情查看链接。'}</p></div>
        {(canManage || resource.url) && <span className={styles.status}>{canManage ? statusLabels[resource.status] : '含资料链接'}</span>}
      </article>) : <p className={styles.empty}>{search ? '没有找到匹配资料，请换一个关键词。' : canManage ? '本学期尚未添加资料。' : '暂无已发布的课程资料。'}</p>}
    </section>
  </div></CourseFrame>;
}
