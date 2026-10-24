import { NextResponse } from 'next/server';
import { destroySession, requireSameOrigin } from '@/lib/auth';

export async function POST() {
  try { await requireSameOrigin(); } catch { return new NextResponse('Forbidden', { status: 403 }); }
  await destroySession();
  return NextResponse.redirect(new URL('/', process.env.APP_URL), 303);
}
