export const teachingRecordKinds = [
  'OBSERVATION',
  'PARTICIPATION',
  'LEAVE_REPORTED',
  'LEAVE_CONFIRMED',
  'TEACHING_JUDGMENT',
  'ABSENT',
] as const;

export type TeachingRecordKind = (typeof teachingRecordKinds)[number];

export const teachingRecordKindLabels: Record<TeachingRecordKind, string> = {
  OBSERVATION: '现场观察',
  PARTICIPATION: '课堂发言',
  LEAVE_REPORTED: '收到请假',
  LEAVE_CONFIRMED: '已确认请假',
  TEACHING_JUDGMENT: '教学判断',
  ABSENT: '未到',
};

export const lessonStudentEventKinds = ['LEAVE_REPORTED', 'ABSENT', 'PARTICIPATION'] as const satisfies readonly TeachingRecordKind[];
export type LessonStudentEventKind = (typeof lessonStudentEventKinds)[number];
