import Link from 'next/link';
import type { CourseRole } from '@/lib/policy';
import styles from './course-navigation.module.css';

export type CourseSection = 'overview' | 'lessons' | 'members' | 'records' | 'learning' | 'assignments' | 'resources' | 'groups' | 'feedback' | 'team' | 'manage';

export function CourseNavigation({ offeringId, active, canManage = false, canViewClassRecords = false, role, groupHref, variant = 'tabs' }: { offeringId: string; active: CourseSection; canManage?: boolean; canViewClassRecords?: boolean; role?: CourseRole; groupHref?: string; variant?: 'tabs' | 'sidebar' }) {
  const student = role === 'STUDENT';
  const groupLink = ['groups', groupHref ?? `/courses/${offeringId}/groups`, student ? '我的小组' : '小组'];
  const primary = [
    ['overview', `/courses/${offeringId}`, '课程首页'],
    ['lessons', `/courses/${offeringId}/pages`, '课次'],
    ['assignments', `/courses/${offeringId}/assignments`, '作业'],
    ...(canViewClassRecords ? [['members', `/courses/${encodeURIComponent(offeringId)}/members`, '学生'], groupLink] : []),
    ...(student ? [groupLink] : []),
  ];
  const secondary = [
    ['resources', `/courses/${offeringId}/resources`, '课程资料'],
    ...(student ? [
      ['learning', `/courses/${offeringId}/learning`, '本学期记录'],
    ] : canViewClassRecords ? [] : [groupLink]),
    ['team', `/courses/${offeringId}/team`, '教学团队'],
    ...(canManage ? [['manage', `/courses/${offeringId}/manage`, '课程管理']] : []),
  ];
  const links = [...primary, ...secondary];
  const current = active === 'records' ? 'lessons' : active === 'feedback' ? 'learning' : active;
  function navigation(className: string) {
    return <nav className={className} aria-label="课程导航">{links.map(([key, href, label], index) => <Link key={key} href={href} className={index === primary.length ? styles.secondaryStart : undefined} aria-current={current === key ? 'page' : undefined}>{label}</Link>)}</nav>;
  }
  if (variant === 'sidebar') return <><div className={styles.desktop}>{navigation(styles.sidebar)}</div><details className={styles.mobile}><summary>课程导航<span>{links.find(([key]) => key === current)?.[2]}</span></summary>{navigation(styles.sidebar)}</details></>;
  return navigation('tabs');
}
