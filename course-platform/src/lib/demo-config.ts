export const DEMO_USERS = [
  { id: 'demo-teacher', label: '演示教师', description: '发布资料与作业，查看提交并反馈，管理成员与小组。' },
  { id: 'demo-ta', label: '演示助教', description: '跟进负责小组，查看本期提交并添加反馈。' },
  { id: 'demo-student-a', label: '演示学生 A', description: '阅读课程资料，提交作业，查看自己的小组记录与反馈。' },
  { id: 'demo-student-b', label: '演示学生 B', description: '阅读课程资料，提交作业，查看自己的小组记录与反馈。' },
  { id: 'demo-admin', label: '演示管理员', description: '管理课程基础资料与成员。' },
] as const;

export function demoAuthEnabled() {
  if (process.env.NODE_ENV !== 'development' || process.env.DEMO_AUTH_ENABLED !== 'true') return false;
  try {
    const hostname = new URL(process.env.APP_URL ?? '').hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}
