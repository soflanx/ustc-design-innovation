import Link from 'next/link';
import type { CourseRole } from '@/lib/policy';
import styles from './course-navigation.module.css';

export type CourseSection = 'overview' | 'assignments' | 'resources' | 'groups' | 'team' | 'manage';

export function CourseNavigation({ offeringId, active, canManage = false, role, groupHref, variant = 'tabs' }: { offeringId: string; active: CourseSection; canManage?: boolean; role?: CourseRole; groupHref?: string; variant?: 'tabs' | 'sidebar' }) {
  const links = [
    ['overview', `/courses/${offeringId}`, '当前教学'],
    ['assignments', `/courses/${offeringId}/assignments`, '作业与反馈'],
    ['resources', `/courses/${offeringId}/resources`, '课程资料'],
    ['groups', groupHref ?? `/courses/${offeringId}/groups`, role === 'STUDENT' ? '我的小组' : '小组'],
    ['team', `/courses/${offeringId}/team`, '教学团队'],
    ...(canManage ? [['manage', `/courses/${offeringId}/manage`, '课程管理']] : []),
  ];
  function navigation(className: string) {
    return <nav className={className} aria-label="课程导航">{links.map(([key, href, label]) => <Link key={key} href={href} aria-current={active === key ? 'page' : undefined}>{label}</Link>)}</nav>;
  }
  if (variant === 'sidebar') return <><div className={styles.desktop}>{navigation(styles.sidebar)}</div><details className={styles.mobile}><summary>课程导航<span>{links.find(([key]) => key === active)?.[2]}</span></summary>{navigation(styles.sidebar)}</details></>;
  return navigation('tabs');
}
