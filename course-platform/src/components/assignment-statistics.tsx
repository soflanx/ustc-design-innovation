import Link from 'next/link';
import type { AssignmentMode } from '@prisma/client';
import { formatTeachingDate } from '@/lib/teaching-format';
import {
  assignmentReviewViews, reviewStateLabels,
  type AssignmentReviewScope, type AssignmentReviewView, type getAssignmentStatistics,
} from '@/lib/teaching-presentation';
import styles from '@/app/teaching.module.css';

const scopeLabels = { mine: '负责范围', all: '全班', unassigned: '未分组学生' };

type Props = {
  statistics: ReturnType<typeof getAssignmentStatistics>;
  mode: AssignmentMode;
  view: AssignmentReviewView;
  scope: AssignmentReviewScope;
  isTa: boolean;
  cancelled: boolean;
  filterHref: (view: AssignmentReviewView, scope?: AssignmentReviewScope) => string;
  versionHref: (versionId: string) => string;
};

export function AssignmentStatistics({ statistics, mode, view, scope, isTa, cancelled, filterHref, versionHref }: Props) {
  const { rows, ownerCount, unassignedCount, missingLabel } = statistics;
  const history = view === 'history';
  const scopeLabel = scopeLabels[scope];
  const scopes: AssignmentReviewScope[] = ['mine', 'all'];
  if (unassignedCount || scope === 'unassigned') scopes.push('unassigned');
  const filters = (Object.keys(assignmentReviewViews) as AssignmentReviewView[]).filter(filter =>
    (filter !== 'missing' || missingLabel !== null) && (filter !== 'unconfirmed' || rows.unconfirmed.length > 0 || view === 'unconfirmed'),
  );
  const rangeText = ownerCount !== null ? `${scopeLabel} · ${ownerCount} ${mode === 'GROUP' ? '个有效小组' : '名有效学生'}`
    : cancelled ? `${scopeLabel} · 仅统计已有提交` : '开放提交后统计应交对象。';
  const emptyText = cancelled ? '当前筛选下暂无已有提交，可查看更正历史。'
    : ownerCount === null ? '当前尚未开放提交。'
    : ownerCount === 0 ? '所选范围没有本项作业的统计对象。'
    : `当前范围暂无${view === 'latest' ? '正式提交' : view === 'missing' ? missingLabel : assignmentReviewViews[view]}记录。`;

  return <section className={styles.reviewOverview} aria-label="提交概况" data-review-view={view} data-review-scope={history ? 'all' : scope}>
    <div className={styles.reviewHeading}>
      <h2>提交情况</h2>
      {isTa && !history && <nav className={styles.scopeSwitch} aria-label="查看范围">
        {scopes.map(item => <Link key={item} href={filterHref(view, item)} aria-current={scope === item ? 'page' : undefined}>
          {scopeLabels[item]}{item === 'unassigned' && `（${unassignedCount}）`}
        </Link>)}
      </nav>}
    </div>
    <p className={styles.countHelp}>{history ? `下列统计仍按进入历史前的「${scopeLabel}」显示。` : rangeText}</p>
    <nav className={styles.reviewFilters} aria-label="提交筛选">
      {filters.map(filter => <Link key={filter} href={filterHref(filter)} aria-current={view === filter ? 'page' : undefined}>
        {filter === 'missing' ? missingLabel : assignmentReviewViews[filter]}
        {filter !== 'history' && <span className={styles.filterCount}> ({rows[filter].length})</span>}
      </Link>)}
    </nav>
    <details className={styles.countDefinition}>
      <summary>统计口径</summary>
      <p>{cancelled ? '作业取消后免交，保留已有提交与反馈。' : '个人作业按本期有效学生统计，小组作业按至少有一名有效学生的小组统计。每个对象只统计最新的正式提交。'}
        {' '}待评阅和已评阅按该版本的评阅状态统计。历史待核对与两者分别计数。更正历史保留已退出成员和小组的记录。</p>
    </details>
    {history ? <p className={styles.historyHelp}>显示本期各次提交，包括已退出成员和小组的记录。</p>
      : rows[view].length ? <div className={styles.queueList}>
        {rows[view].map(row => <div className={styles.queueRow} data-submission-owner={row.id} key={row.id}>
          <div>
            <strong>{row.ownerLabel}</strong>
            {row.submittedAt && <time dateTime={row.submittedAt.toISOString()}>{formatTeachingDate(row.submittedAt)}</time>}
          </div>
          <span>{row.reviewState ? reviewStateLabels[row.reviewState] : missingLabel}</span>
          {row.latestVersionId && <Link href={versionHref(row.latestVersionId)}>查看作品 →</Link>}
        </div>)}
      </div> : <p className={styles.empty}>{emptyText}</p>}
  </section>;
}
