import { NextResponse } from 'next/server';
import { createSession, requireSameOrigin } from '@/lib/auth';
import { db } from '@/lib/db';
import { DEMO_USERS, demoAuthEnabled } from '@/lib/demo-config';
import { loginPath, normalizeReturnTo } from '@/lib/return-to';

export async function POST(request: Request) {
  if (!demoAuthEnabled()) return new NextResponse('Not found', { status: 404 });
  try { await requireSameOrigin(); } catch { return new NextResponse('Forbidden', { status: 403 }); }
  const form = await request.formData();
  const id = String(form.get('userId') ?? '');
  const returnTo = normalizeReturnTo(form.getAll('returnTo').length === 1 ? form.get('returnTo') : undefined);
  if (!DEMO_USERS.some(user => user.id === id)) return new NextResponse('Invalid demo account', { status: 400 });
  const user = await db.user.findFirst({ where: { id, isDemo: true } });
  if (!user) {
    const retry = new URL(loginPath(returnTo), process.env.APP_URL);
    retry.searchParams.set('error', 'account');
    return NextResponse.redirect(retry, 303);
  }
  await createSession(user.id);
  return NextResponse.redirect(new URL(returnTo, process.env.APP_URL), 303);
}
