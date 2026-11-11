export type UstcTerm = {
  key: string;
  year: number;
  season: 'spring' | 'autumn';
  name: string;
  startsOn: string;
  endsOn: string;
  sourceUrl: string;
  sourceTitle: string;
};

const CALENDAR_INDEX = 'https://www.teach.ustc.edu.cn/category/calendar';
const spring2026 = 'https://www.teach.ustc.edu.cn/calendar/19714.html';
const autumn2026 = 'https://www.teach.ustc.edu.cn/calendar/20135.html';

// Verified against the teaching office on 2026-11-03. These snapshots keep
// publishing usable when the university website cannot be reached.
const snapshots: UstcTerm[] = [
  { key: '2026-autumn', year: 2026, season: 'autumn', name: '2026 年秋季学期', startsOn: '2026-08-31', endsOn: '2027-01-15', sourceUrl: autumn2026, sourceTitle: '中国科大教务处 · 2026 年秋季学期' },
  { key: '2026-spring', year: 2026, season: 'spring', name: '2026 年春季学期', startsOn: '2026-03-02', endsOn: '2026-07-03', sourceUrl: spring2026, sourceTitle: '中国科大教务处 · 2026 年春、夏季学期' },
];

export function currentUstcTermKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric' }).formatToParts(now);
  const year = Number(parts.find(part => part.type === 'year')!.value);
  const month = Number(parts.find(part => part.type === 'month')!.value);
  return month === 1 ? `${year - 1}-autumn` : `${year}-${month >= 8 ? 'autumn' : 'spring'}`;
}

function dateOnly(year: number, month: number, day: number) {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : null;
}

/** Read only explicit, complete semester statements from the official calendar. */
export function parseUstcCalendar(html: string, sourceUrl: string): UstcTerm[] {
  const url = new URL(sourceUrl);
  if (url.origin !== 'https://www.teach.ustc.edu.cn' || !/^\/calendar\/\d+\.html$/.test(url.pathname)) return [];
  const text = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;|&#x[aA]0;/g, ' ').replace(/\s+/g, ' ');
  const pattern = /([春秋])季学期于\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*开学注册[，,\s]*((?:(?:\d{4}\s*年\s*)?\d{1,2}\s*月\s*)?\d{1,2}\s*日)\s*上课[，,\s]*(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*学期结束/g;
  const result: UstcTerm[] = [];
  for (const match of text.matchAll(pattern)) {
    const [, chineseSeason, yearText, registrationMonthText, , classDate, endYearText, endMonthText, endDayText] = match;
    const classParts = classDate.match(/(?:(\d{4})\s*年\s*)?(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日/)!;
    const year = Number(classParts[1] || yearText);
    const month = Number(classParts[2] || registrationMonthText);
    const endMonth = Number(endMonthText);
    const start = dateOnly(year, month, Number(classParts[3]));
    const end = dateOnly(endYearText ? Number(endYearText) : year + Number(endMonth < month), endMonth, Number(endDayText));
    if (!start || !end || end <= start) continue;
    const days = (Date.parse(end) - Date.parse(start)) / 86400000;
    if (days < 80 || days > 190) continue;
    const season = chineseSeason === '春' ? 'spring' : 'autumn';
    result.push({ key: `${year}-${season}`, year, season, name: `${year} 年${chineseSeason}季学期`, startsOn: start, endsOn: end, sourceUrl: url.href, sourceTitle: `中国科大教务处 · ${year} 年${chineseSeason}季学期` });
  }
  return result;
}

let cached: { terms: UstcTerm[]; expiresAt: number } | undefined;
let loading: Promise<UstcTerm[]> | undefined;

async function officialPage(url: string) {
  let target = url;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(target, { signal: AbortSignal.timeout(2500), redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Calendar unavailable');
      const redirected = new URL(location, target);
      if (redirected.hostname !== 'www.teach.ustc.edu.cn' || !['http:', 'https:'].includes(redirected.protocol) || redirected.username || redirected.password) throw new Error('Invalid calendar source');
      redirected.protocol = 'https:';
      target = redirected.href;
      continue;
    }
    if (!response.ok) throw new Error('Calendar unavailable');
    return response.text();
  }
  throw new Error('Calendar unavailable');
}

async function refreshCalendar() {
  const byKey = new Map(snapshots.map(term => [term.key, { ...term }]));
  let urls: string[] = [];
  try {
    const index = await officialPage(CALENDAR_INDEX);
    urls = [...new Set([...index.matchAll(/href\s*=\s*["']((?:https?:\/\/www\.teach\.ustc\.edu\.cn)?\/calendar\/\d+\.html)["']/gi)].map(match => {
      const source = new URL(match[1], CALENDAR_INDEX);
      source.protocol = 'https:';
      return source.href;
    }))].slice(0, 4);
  } catch { /* Use the verified source pages when discovery is unavailable. */ }
  if (!urls.length) urls = [autumn2026, spring2026];
  const pages = await Promise.allSettled(urls.map(async url => parseUstcCalendar(await officialPage(url), url)));
  for (const page of pages) if (page.status === 'fulfilled') for (const term of page.value) byKey.set(term.key, term);
  const terms = [...byKey.values()].sort((a, b) => b.startsOn.localeCompare(a.startsOn));
  cached = { terms, expiresAt: Date.now() + 60 * 60 * 1000 };
  return terms;
}

/** No estimated academic dates are used when a future calendar is not published. */
export async function loadUstcCalendar(): Promise<UstcTerm[]> {
  if (process.env.NODE_ENV === 'test') return snapshots.map(term => ({ ...term }));
  if (cached && cached.expiresAt > Date.now()) return cached.terms.map(term => ({ ...term }));
  if (!loading) loading = refreshCalendar().finally(() => { loading = undefined; });
  return (await loading).map(term => ({ ...term }));
}
