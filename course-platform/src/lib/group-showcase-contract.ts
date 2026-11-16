import { groupWorkHref } from './group-work-link';

export type ShowcaseScope = 'CLASS' | 'PUBLIC';
export type ShowcaseSourceKind = 'ACTIVITY' | 'SUBMISSION';

export const showcaseScopeLabels = { CLASS: '班内分享', PUBLIC: '互联网发布' } as const;

export type ShowcaseSelection = {
  source: ShowcaseSourceKind;
  sourceId: string;
  fileId: string | null;
  caption: string;
};

export type ShowcaseDraft = {
  title: string;
  summary: string;
  body: string;
  selections: ShowcaseSelection[];
};

export type ShowcaseSource = {
  source: ShowcaseSourceKind;
  id: string;
  label: string;
  body: string;
  href: string;
  files: { id: string; name: string; image: boolean; href: string }[];
};

export type ShowcasePublicationStatus = {
  id: string;
  draftRevision: number;
  publishedAt: Date;
  withdrawnAt: Date | null;
};

export type ShowcaseWorkspace = {
  groupName: string;
  projectTitle: string;
  draft: (ShowcaseDraft & { revision: number }) | null;
  sources: ShowcaseSource[];
  publications: Record<ShowcaseScope, ShowcasePublicationStatus | null>;
  canEdit: boolean;
  canPublish: boolean;
  canWithdraw: boolean;
};

export type ShowcaseMaterial = {
  id: string;
  caption: string;
  sourceLabel: string;
  text: string | null;
  file: { name: string; image: boolean } | null;
};

export type ShowcaseStory = {
  publicationId: string;
  title: string;
  summary: string;
  body: string;
  groupName: string;
  materials: ShowcaseMaterial[];
};

export type ShowcaseListing = Pick<ShowcaseStory, 'title' | 'summary' | 'groupName'> & { groupId: string };

export const showcaseDraftLimits = { title: 100, summary: 240, body: 12000, caption: 500, materials: 30 };

export function showcaseSelectionKey(selection: Omit<ShowcaseSelection, 'caption'>) {
  return JSON.stringify([selection.source, selection.sourceId, selection.fileId]);
}

export function showcasePublicationToken(status: ShowcasePublicationStatus | null) {
  return status ? status.id + (status.withdrawnAt ? ':withdrawn' : '') : null;
}

type ShowcaseReviewText = Pick<ShowcaseDraft, 'title' | 'body'>;

export function showcaseHasReviewText(draft: ShowcaseReviewText | null) {
  return !!(draft?.title.trim() && draft.body.trim());
}

export function showcaseReviewStatus(
  draft: ShowcaseReviewText & { revision: number },
  publications: readonly (Pick<ShowcasePublicationStatus, 'draftRevision' | 'withdrawnAt'> & { scope: ShowcaseScope })[],
  canPublish: boolean,
  { hasUnavailableActivity }: { hasUnavailableActivity?: boolean } = {},
) {
  const published = publications.filter(publication => !publication.withdrawnAt);
  const publishedScopes = published.map(publication => showcaseScopeLabels[publication.scope]).join('、');
  if (hasUnavailableActivity) return publishedScopes ? `所选材料需更换 · ${publishedScopes}仍可查看` : '所选材料需更换';
  if (!showcaseHasReviewText(draft)) return '草稿待补齐';
  if (canPublish) {
    const outdatedScopes = published.filter(publication => publication.draftRevision < draft.revision)
      .map(publication => showcaseScopeLabels[publication.scope]);
    if (outdatedScopes.length) return `有未确认更新（${outdatedScopes.join('、')}）`;
    if (!publications.length) return '尚未确认';
  }
  if (publishedScopes) return `${publishedScopes}已确认`;
  if (publications.length) return '已撤回';
}

export function showcaseWorkspaceHref(offeringId: string, groupId: string, origin?: URLSearchParams, preview = false) {
  const path = `${groupWorkHref(offeringId, undefined, groupId)}/showcase`;
  const query = new URLSearchParams(origin);
  if (preview) query.set('view', 'preview');
  return `${path}${query.size ? `?${query}` : ''}`;
}

export function showcaseReadHref(offeringId: string, groupId: string, scope: ShowcaseScope) {
  return `/courses/${encodeURIComponent(offeringId)}/showcase/${encodeURIComponent(groupId)}/${scope === 'CLASS' ? 'class' : 'public'}`;
}

export function showcaseMaterialHref(offeringId: string, groupId: string, scope: ShowcaseScope, publicationId: string, materialId: string) {
  return `${showcaseReadHref(offeringId, groupId, scope)}/${encodeURIComponent(publicationId)}/files/${encodeURIComponent(materialId)}`;
}
