type CourseIdentity = { slug: string; title: string };
type OfferingIdentity = { course: CourseIdentity; title: string; term: { name: string } };

// Use established abbreviations only; unfamiliar courses keep their real names.
const courseNames: Record<string, string> = { 'design-thinking': '思维', 'design-practice': '实践' };

function practicePart(termName: string, offeringTitle = ''): '' | 'Ⅰ' | 'Ⅱ' {
  // A saved offering name records its identity even when its term is later renamed.
  // Match a course part, rather than interpreting the digits in a year as I or II.
  const normalized = offeringTitle.normalize('NFKC');
  const explicit = normalized.match(/实践\s*(?:[（(]\s*)?(II|I|[12])(?=$|[\s·・（(）)\-—–:：])/i)
    ?? normalized.match(/^\s*(II|I|[12])(?=$|[\s·・（(）)\-—–:：])/i);
  if (explicit) return ['II', '2'].includes(explicit[1].toUpperCase()) ? 'Ⅱ' : 'Ⅰ';
  if (termName.includes('秋')) return 'Ⅰ';
  if (termName.includes('春')) return 'Ⅱ';
  return '';
}

export function offeringCourseTitle(offering: OfferingIdentity) {
  const { course, title, term } = offering;
  if (course.slug !== 'design-practice') return course.title;
  const part = practicePart(term.name, title);
  if (!part) return course.title;
  const base = course.title.replace(/\s*(?:Ⅱ|Ⅰ|II|I|[12])$/i, '');
  return `${base}${part}`;
}

export function courseLabel(course: CourseIdentity, termName: string, offeringTitle?: string) {
  const part = course.slug === 'design-practice' ? practicePart(termName, offeringTitle) : '';
  const shortName = (courseNames[course.slug] ?? course.title) + part;
  const term = termName.replace(/^(\d{4})\s*年?\s*([春夏秋冬])季?\s*(?:学期)?\s*$/, '$1$2');
  return `${shortName} · ${term}`;
}
