export type CourseRole = 'STUDENT' | 'TA' | 'TEACHER';
export type Membership = { role: CourseRole; status: 'ACTIVE' | 'INACTIVE' } | null;

export function canViewOffering(isAdmin: boolean, membership: Membership) {
  return isAdmin || membership?.status === 'ACTIVE';
}

export function canManageOffering(isAdmin: boolean, membership: Membership) {
  return isAdmin || (membership?.status === 'ACTIVE' && membership.role === 'TEACHER');
}

export function canViewGroup(isAdmin: boolean, membership: Membership, isActiveGroupMember: boolean) {
  if (isAdmin) return true;
  if (membership?.status !== 'ACTIVE') return false;
  return membership.role === 'TEACHER' || membership.role === 'TA' || isActiveGroupMember;
}

export const roleLabels: Record<CourseRole, string> = { STUDENT: '学生', TA: '助教', TEACHER: '教师' };
export const statusLabels: Record<string, string> = { DRAFT: '筹备中', ACTIVE: '进行中', ARCHIVED: '已归档' };

export function displayDate(date: Date) {
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
}
