import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireOfferingAccess } from '@/lib/access';
import { getCourseResource } from '@/lib/resource-service';
import { CourseFrame } from '@/components/course-frame';
import { ResourceForm } from '@/components/resource-fields';
import styles from '@/app/resources.module.css';

export default async function ResourcePage({ params, searchParams }: { params: Promise<{ offeringId: string; resourceId: string }>; searchParams: Promise<{ q?: string; edit?: string }> }) {
  const { offeringId, resourceId } = await params;
  const { q, edit } = await searchParams;
  const search = typeof q === 'string' ? q.trim().slice(0, 100) : '';
  const base = `/courses/${encodeURIComponent(offeringId)}/resources`;
  const path = `${base}/${encodeURIComponent(resourceId)}`;
  const query = new URLSearchParams();
  if (edit === '1') query.set('edit', '1');
  if (search) query.set('q', search);
  const { user, offering, membership } = await requireOfferingAccess(offeringId, edit === '1', path + (query.size ? '?' + query : ''));
  const { resource } = await getCourseResource(user.id, offeringId, resourceId);
  if (!resource) notFound();
  if (edit !== '1' || offering.status === 'ARCHIVED') redirect(path + '/open');

  const returnTo = base + (search ? `?${new URLSearchParams({ q: search })}` : '');
  return <CourseFrame user={user} offering={offering} membership={membership} active="resources"><div className={styles.page}>
    <header className={styles.heading}>
      <Link className="breadcrumb" href={returnTo}>← {search ? '搜索结果' : '课程资料'}</Link>
      <h1>编辑资料</h1>
    </header>
    <div className={styles.formBody}><ResourceForm key={JSON.stringify([user.id, offeringId, resourceId])} userId={user.id} offeringId={offeringId} resource={resource} search={search}/></div>
  </div></CourseFrame>;
}
