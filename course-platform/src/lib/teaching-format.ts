export function formatTeachingDate(value: Date | string | null) {
  if (!value) return '未设置截止时间';
  return `${new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })}（北京时间）`;
}

export function toTeachingDateInput(value: Date | string | null) {
  return value ? new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 16) : '';
}

export function parseTeachingDateInput(value: string): Date | null {
  if (!value.trim()) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('INVALID_TEACHING_DATE');
  const date = new Date(`${value}:00+08:00`);
  if (!Number.isFinite(date.getTime()) || toTeachingDateInput(date) !== value) throw new Error('INVALID_TEACHING_DATE');
  return date;
}
