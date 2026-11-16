import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { CourseFrame } from '@/components/course-frame';
import { GroupShowcaseEditor } from '@/components/group-showcase-editor';
import { GroupShowcaseStory } from '@/components/group-showcase-story';
import styles from '@/components/group-showcase-editor.module.css';
import { requireOfferingAccess } from '@/lib/access';
import { offeringCourseTitle } from '@/lib/course-label';
import { getGroupShowcaseWorkspace } from '@/lib/group-showcase';
import { confirmShowcaseAction, withdrawShowcaseAction } from '@/lib/group-showcase-actions';
import {
  showcaseHasReviewText, showcasePublicationToken, showcaseReadHref, showcaseScopeLabels, showcaseWorkspaceHref,
  type ShowcaseMaterial, type ShowcaseScope,
} from '@/lib/group-showcase-contract';
import { groupWorkHref } from '@/lib/group-work-link';
import { getGroupWorkOrigin, groupWorkOriginParams, type GroupWorkOriginQuery } from '@/lib/group-work-origin';
import { isActiveTeachingMember } from '@/lib/policy';
import { formatTeachingDate } from '@/lib/teaching-format';

const audiences: { scope: ShowcaseScope; readers: string }[] = [
  { scope: 'CLASS', readers: '本期课程成员可以从课程首页阅读本次确认的内容。' },
  { scope: 'PUBLIC', readers: '本次确认的展示将进入公开项目目录和开课页。访客无需登录即可阅读并打开所选附件。' },
];

export default async function ShowcaseWorkspacePage({ params, searchParams }: {
  params: Promise<{ offeringId: string; groupId: string }>;
  searchParams: Promise<GroupWorkOriginQuery & { view?: unknown; fromGroups?: unknown }>;
}) {
  const { offeringId, groupId } = await params;
  const query = await searchParams;
  const preview = query.view === 'preview';
  const requested = groupWorkOriginParams(query);
  if (query.fromGroups === '1') requested.set('fromGroups', '1');
  const { user, offering, membership } = await requireOfferingAccess(offeringId, false, showcaseWorkspaceHref(offeringId, groupId, requested, preview));
  const workspace = await getGroupShowcaseWorkspace(user.id, offeringId, groupId);
  if (!workspace) notFound();
  const { source, lessonRecords, memberReturn, lessonReturn, params: origin } = await getGroupWorkOrigin(user, membership, offeringId, groupId, requested);
  const teachingTeam = isActiveTeachingMember(membership);
  const fromGroups = teachingTeam && requested.has('fromGroups');
  if (fromGroups) origin.set('fromGroups', '1');
  const editHref = showcaseWorkspaceHref(offeringId, groupId, origin);
  const previewHref = showcaseWorkspaceHref(offeringId, groupId, origin, true);
  const back = memberReturn ?? lessonReturn ?? (fromGroups
    ? { href: groupWorkHref(offeringId), label: '返回小组列表' }
    : { href: groupWorkHref(offeringId, undefined, groupId), label: '返回小组工作页' });
  const { canEdit, canPublish, canWithdraw, sources, publications, groupName, draft } = workspace;
  const editing = canEdit && !preview;
  const draftBody = draft ?? { revision: 0, title: workspace.projectTitle, summary: '', body: '', selections: [] };
  const sourceIndex = new Map(sources.map(item => [JSON.stringify([item.source, item.id]), item]));
  const fileHrefs = new Map<string, string>();
  const materials: ShowcaseMaterial[] = [];
  for (const [index, selection] of draftBody.selections.entries()) {
    const source = sourceIndex.get(JSON.stringify([selection.source, selection.sourceId]));
    const file = source?.files.find(item => item.id === selection.fileId);
    if (!source || (selection.fileId ? !file : !source.body.trim())) continue;
    const id = `preview-${index}`;
    if (file) fileHrefs.set(id, file.image && selection.source === 'SUBMISSION' ? `${file.href}?preview=1` : file.href);
    materials.push({
      id, caption: selection.caption, sourceLabel: source.label,
      text: selection.fileId ? null : source.body,
      file: file ? { name: file.name, image: file.image } : null,
    });
  }
  const missingMaterials = materials.length !== draftBody.selections.length;
  const reviewable = showcaseHasReviewText(draft) && !missingMaterials;
  return <CourseFrame user={user} offering={offering} membership={membership} active="groups" groupSourcePageId={source?.id} groupSourceLessonRecords={lessonRecords}>
    <div className={styles.workspace}>
      <div className={styles.previewTools}>
        <Link className="breadcrumb" href={back.href}>← {back.label}</Link>
        {!editing && canEdit && <Link href={editHref}>继续整理</Link>}
        {editing && draft && <Link href={previewHref}>预览已保存稿</Link>}
      </div>
      {editing ? <>
        <header><h1>整理展示</h1><p className={styles.meta}>{groupName}</p></header>
        <GroupShowcaseEditor key={JSON.stringify([user.id, offeringId, groupId])} viewerId={user.id}
          offeringId={offeringId} groupId={groupId} initial={draftBody} sources={sources} editHref={editHref} previewHref={previewHref}/>
      </> : draft ? <>
        <p className={styles.meta}>展示草稿预览</p>
        {missingMaterials && <p className="notice error">有已选材料无法读取。请由组员移除或更换这些材料后再确认。</p>}
        <GroupShowcaseStory story={{ publicationId: '', title: draft.title || workspace.projectTitle, summary: draft.summary,
          body: draft.body, groupName, materials }} courseTitle={offeringCourseTitle(offering)} termName={offering.term.name}
          materialHref={material => fileHrefs.get(material.id)}/>
      </> : <header><h1>小组展示</h1><p className={styles.meta}>组员还没有保存展示草稿。</p></header>}
      {(draft || publications.CLASS || publications.PUBLIC) && <section className={styles.release} aria-labelledby="showcase-release-title">
        <h2 id="showcase-release-title">分享与发布</h2>
        {canPublish && draft && !reviewable && !missingMaterials && <p className="field-help">组员填好项目标题和正文后，可以确认分享或发布。</p>}
        {audiences.map(({ scope, readers }) => {
          const label = showcaseScopeLabels[scope];
          const confirmLabel = `确认${label}`;
          const status = publications[scope];
          const published = status && !status.withdrawnAt;
          const matchesDraft = published && status.draftRevision === draft?.revision;
          const readHref = showcaseReadHref(offeringId, groupId, scope);
          return <div key={scope} className={styles.releaseItem}>
            <h3>{label}</h3>
            {published ? <>
              <p className={styles.meta}>已确认 · <time dateTime={status.publishedAt.toISOString()}>{formatTeachingDate(status.publishedAt)}</time>{!matchesDraft && ' · 当前展示仍为上次确认稿'}</p>
              <a href={readHref}>查看{label} →</a>
            </> : <p className={styles.meta}>{status?.withdrawnAt ? '已撤回' : scope === 'CLASS' ? '尚未分享' : '尚未发布'}</p>}
            {canPublish && reviewable && draft && !matchesDraft && <details key={`${draft.revision}:${showcasePublicationToken(status)}`}>
              <summary>{published ? `以当前草稿更新${label}` : confirmLabel}</summary>
              <ActionForm action={confirmShowcaseAction.bind(null, offeringId, groupId, user.id, scope, draft.revision, showcasePublicationToken(status))}
                submitLabel={confirmLabel} className="stack">
                <p className="field-help">{readers}</p>
              </ActionForm>
            </details>}
            {canWithdraw && published && <details key={status.id}>
              <summary>撤回{label}</summary>
              <ActionForm action={withdrawShowcaseAction.bind(null, offeringId, groupId, user.id, scope, status.id)}
                submitLabel={`确认撤回${label}`} className="stack">
                <p className="field-help">撤回后，此范围的展示页与已分享的附件地址将停止提供。</p>
              </ActionForm>
            </details>}
          </div>;
        })}
        {canPublish && <Link className={styles.reviewBack} href={back.href}>← {back.label}</Link>}
      </section>}
    </div>
  </CourseFrame>;
}
