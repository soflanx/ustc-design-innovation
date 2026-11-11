import Link from 'next/link';
import type { ReactNode } from 'react';
import type { CourseDocumentCatalog, CourseDocumentRecord } from '@/lib/course-document-view';
import { formatTeachingDate } from '@/lib/teaching-format';
import { CourseContentIcon } from './course-content-icon';
import { CourseResourcePreview } from './course-resource-preview';
import styles from './course-record-view.module.css';

type Kind = keyof CourseDocumentCatalog;
const recordLabels = { assignments: '作业', resources: '资料', groups: '小组', pages: '课次' };
const recordIcons = { assignments: 'assignment', resources: 'resource', groups: 'group', pages: 'link' } as const;
const shortDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function CourseAssignmentDeadline({ record }: { record: CourseDocumentRecord }) {
  if (record.visibilityStatus === 'CANCELLED') return <span>已取消，免交</span>;
  const deadline = record.deadline ? new Date(record.deadline) : null;
  if (!deadline || !Number.isFinite(deadline.getTime())) return <span>未设截止</span>;
  return <time dateTime={deadline.toISOString()} title={formatTeachingDate(deadline)}>{shortDate.format(deadline)} 截止</time>;
}

export function CourseRecordLink({ record, kind, editing = false, className, children }: {
  record: CourseDocumentRecord; kind: Kind; editing?: boolean; className?: string; children?: ReactNode;
}) {
  const action = record.actionLabel ?? `打开${recordLabels[kind]}`;
  const inNewTab = editing || record.opensInNewTab;
  const TitleLink = kind === 'resources' ? 'a' : Link;
  return <TitleLink className={className} href={record.href} target={inNewTab ? '_blank' : undefined} rel={inNewTab ? 'noopener noreferrer' : undefined}
    title={inNewTab ? `${action}（新标签页）` : action} aria-label={`${record.title}，${action}${inNewTab ? '（新标签页）' : ''}`}>
    {children ?? record.title}
  </TitleLink>;
}

export function CourseInlineRecord({ record, kind, editing = false }: {
  record: CourseDocumentRecord; kind: Kind; editing?: boolean;
}) {
  return <><CourseRecordLink record={record} kind={kind} editing={editing}/>{kind === 'assignments' &&
    <span className={styles.inlineDeadline}>（<CourseAssignmentDeadline record={record}/>）</span>}
    {kind === 'resources' && <CourseResourcePreview href={record.href} title={record.title}/>}</>;
}

function ReferenceFacts({ record, kind }: { record: CourseDocumentRecord; kind: Kind }) {
  const facts: ReactNode[] = [];
  if (kind === 'assignments') {
    if (record.assignmentMode) facts.push(record.assignmentMode === 'GROUP' ? '小组提交' : '个人提交');
    const cancelled = record.visibilityStatus === 'CANCELLED';
    const lifecycle = record.lifecycleHint === '可提交' ? undefined : record.lifecycleHint;
    const state = cancelled ? '已取消，免交' : lifecycle ?? (record.visibilityStatus === 'DRAFT' ? '草稿' : undefined);
    if (!cancelled) facts.push(<CourseAssignmentDeadline record={record}/>);
    if (state) facts.push(state);
    if (!cancelled && record.scope === 'self' && record.progressHint) facts.push(record.progressHint);
  } else if (kind === 'groups') {
    const repeatedTitle = record.title + ' · ';
    const subtitle = record.subtitle?.startsWith(repeatedTitle) ? record.subtitle.slice(repeatedTitle.length) : record.subtitle;
    if (subtitle) facts.push(subtitle);
  } else if (record.status && record.status !== '已发布') facts.push(record.status);
  return facts.length > 0 && <span className={styles.meta}>{facts.map((fact, index) =>
    <span key={index} className={styles.fact}>{index > 0 && <span className={styles.separator} aria-hidden="true">·</span>}{fact}</span>,
  )}</span>;
}

export function CourseRecordView({ record, kind, display = 'link', editing = false, controls }: {
  record: CourseDocumentRecord; kind: Kind; display?: 'link' | 'card'; editing?: boolean; controls?: ReactNode;
}) {
  const icon = kind === 'resources' && record.resourceFormat === '外部链接' ? 'link' : recordIcons[kind];
  return <article className={styles.record} data-display={display} data-course-reference={kind}
    data-current-task={kind === 'assignments' ? record.id : undefined} data-assignment-scope={kind === 'assignments' ? record.scope : undefined}>
    <div className={styles.heading}>
      <CourseRecordLink record={record} kind={kind} editing={editing} className={styles.link}>
        <CourseContentIcon name={icon} size={17}/><span className={styles.title}>{record.title}</span>
        {kind === 'resources' && (record.resourceFormat || record.resourceAction) && <span className={styles.meta}>
          {record.resourceFormat && <span>{record.resourceFormat}</span>}
          {record.resourceAction && <span className={styles.resourceAction}>{record.resourceFormat && <span className={styles.separator} aria-hidden="true">·</span>}
            {record.resourceAction === 'download' ? '下载' : '打开'}
          </span>}
        </span>}
      </CourseRecordLink>
      <ReferenceFacts record={record} kind={kind}/>
      {kind === 'resources' && <CourseResourcePreview href={record.href} title={record.title}/>}
    </div>
    {controls && <div className={styles.controls}>{controls}</div>}
  </article>;
}
