import { notFound, redirect } from 'next/navigation';
import { requireOfferingAccess } from '@/lib/access';
import { db } from '@/lib/db';
import { parseGroupSource } from '@/lib/group-work-link';

type QueryValue = string | string[] | undefined;

function parseFilter(value: QueryValue) {
  if (value === undefined || value === '') return;
  return parseGroupSource(value) ?? notFound();
}

export default async function TeachingRecordsPage({ params, searchParams }: {
  params: Promise<{ offeringId: string }>;
  searchParams: Promise<{ fromPage?: QueryValue; memberId?: QueryValue; includeWithdrawn?: QueryValue }>;
}) {
  const { offeringId } = await params;
  const query = await searchParams;
  const pageId = parseFilter(query.fromPage);
  const memberId = parseFilter(query.memberId);
  const includeWithdrawn = query.includeWithdrawn === '1';
  const base = `/courses/${encodeURIComponent(offeringId)}`;
  const original = new URLSearchParams();
  if (pageId) original.set('fromPage', pageId);
  if (memberId) original.set('memberId', memberId);
  if (includeWithdrawn) original.set('includeWithdrawn', '1');
  const { membership } = await requireOfferingAccess(offeringId, false, `${base}/records${original.size ? `?${original}` : ''}`);
  if (membership?.status !== 'ACTIVE' || (membership.role !== 'TEACHER' && membership.role !== 'TA')) notFound();
  if (!pageId) redirect(`${base}/pages`);

  const page = await db.courseSubpage.findFirst({ where: { offeringId, id: pageId }, select: { id: true } });
  if (!page) notFound();
  const next = new URLSearchParams({ view: 'records' });
  if (includeWithdrawn) next.set('includeWithdrawn', '1');
  redirect(`${base}/pages/${encodeURIComponent(page.id)}?${next}`);
}
