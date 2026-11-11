export const COURSE_PRESETS = [
  { key: 'thinking', slug: 'design-thinking', title: '设计创新思维' },
  { key: 'practice', slug: 'design-practice', title: '设计创新实践' },
] as const;

export type CoursePresetKey = (typeof COURSE_PRESETS)[number]['key'];

export function getCoursePreset(key: string) {
  return COURSE_PRESETS.find(preset => preset.key === key);
}

export function presetOfferingTitle(key: CoursePresetKey, season: 'spring' | 'autumn') {
  const course = getCoursePreset(key)!;
  return course.title + (key === 'practice' ? season === 'autumn' ? 'Ⅰ' : 'Ⅱ' : '');
}
