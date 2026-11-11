import { isSafeCourseUrl } from './course-document';
import type { CourseSubpageSummary } from './course-subpages';

/** Values in this catalog have already passed the current reader's course permissions. */
export type CourseDocumentRecord = {
  id: string;
  title: string;
  subtitle?: string;
  status?: string;
  href: string;
  actionLabel?: string;
  detail?: string;
  scope?: 'mine' | 'self' | 'all';
  secondaryHref?: string;
  secondaryLabel?: string;
  lifecycleLabel?: string;
  lifecycleHint?: string;
  assignmentMode?: 'INDIVIDUAL' | 'GROUP';
  /** Personal or current-group state, never copied to the generic student preview. */
  progressHint?: string;
  deadline?: string;
  visibilityStatus?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'CANCELLED';
  /** Public presentation of a visible course resource. */
  resourceFormat?: string;
  resourceAction?: 'open' | 'download';
  opensInNewTab?: boolean;
  /** Supplied only to teachers/managers, never to student or TA catalogs. */
  assignment?: { title: string; description: string; mode: 'INDIVIDUAL' | 'GROUP'; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'CANCELLED'; dueAt: string; versionCount: number; revision: number; cancellationReason: string | null; maxScore: number };
  resource?: { title: string; body: string; url: string; file?: { name: string; size: number } | null; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; revision: number; firstPublishedAt?: string | null };
};

export type CourseDocumentCatalog = {
  assignments: CourseDocumentRecord[];
  resources: CourseDocumentRecord[];
  groups: CourseDocumentRecord[];
  /** Only the course home can link to its subpages as records. */
  pages?: CourseDocumentRecord[];
};

export function courseSubpageReference(offeringId: string, page: CourseSubpageSummary): CourseDocumentRecord {
  return {
    id: page.id,
    title: page.publishedTitle ?? page.title,
    href: `/courses/${encodeURIComponent(offeringId)}/pages/${encodeURIComponent(page.id)}`,
    visibilityStatus: page.publishedAt ? 'PUBLISHED' : 'DRAFT',
    status: page.publishedAt ? (page.hasDraft ? '有未发布修改' : undefined) : '草稿',
  };
}

export function safeDocumentUrl(value: unknown): string | undefined {
  return typeof value === 'string' && isSafeCourseUrl(value) ? value : undefined;
}

export function documentRecordIds(value: unknown): string[] {
  try {
    const ids: unknown = JSON.parse(typeof value === 'string' ? value : '[]');
    return Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string'))] : [];
  } catch { return []; }
}
