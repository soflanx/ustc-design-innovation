type CourseIdentity = { slug: string; title: string };

// Use established abbreviations only; unfamiliar courses keep their real names.
const courseNames: Record<string, string> = { 'design-thinking': '思维', 'design-practice': '实践' };

export function courseLabel(course: CourseIdentity, termName: string) {
  const shortName = courseNames[course.slug] ?? course.title;
  const term = termName.replace(/^(\d{4})\s*年?\s*([春夏秋冬])季?\s*(?:学期)?\s*$/, '$1$2');
  return `${shortName} · ${term}`;
}
