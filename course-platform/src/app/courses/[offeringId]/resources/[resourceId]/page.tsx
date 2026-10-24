import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOfferingAccess } from '@/lib/access';
import { getCourseResource } from '@/lib/resource-service';
import { updateResourceAction } from '@/lib/resource-actions';
import { CourseFrame } from '@/components/course-frame';
import { ActionForm } from '@/components/action-form';
import { ResourceFields } from '@/components/resource-fields';
import styles from '@/app/resources.module.css';

const statusLabels: Record<string, string> = { DRAFT: '草稿', PUBLISHED: '已发布', ARCHIVED: '已下架' };

export default async function ResourcePage({ params, searchParams }: { params: Promise<{ offeringId: string; resourceId: string }>; searchParams: Promise<{ q?: string }> }) {
  const { offeringId, resourceId } = await params;
  const query = (await searchParams).q;
  const search = typeof query === 'string' ? query.trim().slice(0, 100) : '';
  const searchQuery = search ? `?${new URLSearchParams({ q: search })}` : '';
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, `/courses/${offeringId}/resources/${resourceId}${searchQuery}`);
  const { resource, canManage } = await getCourseResource(user.id, offeringId, resourceId);
  if (!resource) notFound();
  const archived = offering.status === 'ARCHIVED';
  return <CourseFrame user={user} offering={offering} membership={membership} active="resources"><div className={styles.page}>
    <header className={styles.heading}><Link className="breadcrumb" href={`/courses/${offeringId}/resources${searchQuery}`}>← {search ? '搜索结果' : '课程资料'}</Link><h1>{resource.title}</h1></header>
    {archived && <p className={styles.notice}>本学期已归档，课程资料保持只读。</p>}
    <article className={styles.reading}>
      {canManage && resource.status !== 'PUBLISHED' && <p className={styles.status}>{statusLabels[resource.status]}</p>}
      {resource.url && <div className={styles.external}><a className="button primary" href={resource.url} target="_blank" rel="noopener noreferrer">打开资料链接 ↗</a><p>{new URL(resource.url).hostname}</p></div>}
      {resource.body && <div className={styles.body}>{resource.body}</div>}
    </article>
    {canManage && !archived && <details className={styles.editor}><summary>编辑资料</summary><div className={styles.editorBody}><ActionForm action={updateResourceAction.bind(null, offeringId, resourceId)} submitLabel="保存修改"><ResourceFields resource={resource}/></ActionForm></div></details>}
  </div></CourseFrame>;
}
