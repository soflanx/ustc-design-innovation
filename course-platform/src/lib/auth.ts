import { createHash, randomBytes } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from './db';
import { DEFAULT_RETURN_TO, loginPath } from './return-to';

export const SESSION_COOKIE = 'design-course-session';
const SESSION_DURATION = 8 * 60 * 60 * 1000;

export function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function getCurrentUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = await db.authSession.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt <= new Date()) return null;
  return session.user;
}

export async function requireUser(returnTo = DEFAULT_RETURN_TO) {
  const user = await getCurrentUser();
  if (!user) redirect(loginPath(returnTo));
  return user;
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DURATION);
  const cookieStore = await cookies();
  const previous = cookieStore.get(SESSION_COOKIE)?.value;
  if (previous) await db.authSession.deleteMany({ where: { tokenHash: hashSessionToken(previous) } });
  await db.authSession.create({ data: { tokenHash: hashSessionToken(token), userId, expiresAt } });
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.APP_URL?.startsWith('https://') ?? false,
    path: '/',
    expires: expiresAt,
  });
}

export async function destroySession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) await db.authSession.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
  cookieStore.delete(SESSION_COOKIE);
}

export async function requireSameOrigin() {
  const origin = (await headers()).get('origin');
  const expected = process.env.APP_URL;
  if (!origin || !expected || origin !== new URL(expected).origin) throw new Error('请求来源不匹配，请从网站页面重新操作。');
}
