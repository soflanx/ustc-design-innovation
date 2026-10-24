export const DEFAULT_RETURN_TO = '/workspace';

const base = 'https://return-to.invalid';
const unsafeCharacters = /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const blockedPath = /^\/(?:api|login|logout|_next)(?:\/|$)/i;
const maxDecodeDepth = 5;

function hasEncodedUnsafeCharacters(value: string) {
  let decoded = value;
  for (let depth = 0; depth < maxDecodeDepth; depth++) {
    if (unsafeCharacters.test(decoded) || /%c2%[89][\da-f]|%e2%80%a[89]/i.test(decoded)) return true;
    // Decode ASCII escapes only, so legitimate UTF-8 searches and escaped
    // percent signs remain valid while nested control/backslash escapes do not.
    const next = decoded.replace(/%([0-7][\da-f])/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === decoded) return false;
    decoded = next;
  }
  return unsafeCharacters.test(decoded) || /%[0-7][\da-f]/i.test(decoded);
}

/** Accept only local page paths; this target never grants access to the page. */
export function normalizeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value !== value.trim()
    || !value.startsWith('/') || value.startsWith('//') || hasEncodedUnsafeCharacters(value)) return DEFAULT_RETURN_TO;

  try {
    // Reject malformed percent/UTF-8 encoding rather than relying on differing
    // browser, proxy, and router interpretations of it.
    if (unsafeCharacters.test(decodeURI(value))) return DEFAULT_RETURN_TO;
    const target = new URL(value, base);
    if (target.origin !== base || target.pathname.startsWith('//')) return DEFAULT_RETURN_TO;
    let path = target.pathname;
    for (let depth = 0; depth < maxDecodeDepth; depth++) {
      // Encoded path separators and query/hash delimiters are unnecessary for
      // our routes and can obscure a blocked or protocol-relative destination.
      if (/%(?:2f|5c|3f|23)/i.test(path) || unsafeCharacters.test(path) || path.startsWith('//')) return DEFAULT_RETURN_TO;
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
    if (path.includes('%') || unsafeCharacters.test(path) || path.startsWith('//')) return DEFAULT_RETURN_TO;
    const normalizedPath = new URL(path, base).pathname;
    if (normalizedPath.startsWith('//') || blockedPath.test(normalizedPath)) return DEFAULT_RETURN_TO;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

export function loginPath(returnTo: unknown = DEFAULT_RETURN_TO): string {
  const target = normalizeReturnTo(returnTo);
  return target === DEFAULT_RETURN_TO ? '/login' : `/login?${new URLSearchParams({ returnTo: target })}`;
}
