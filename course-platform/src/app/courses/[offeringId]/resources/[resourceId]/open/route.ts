import { requireUser } from '@/lib/auth';
import { DomainError } from '@/lib/management';
import { getCourseResourceFile } from '@/lib/resource-service';

const privateHeaders = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };

export async function GET(request: Request, { params }: { params: Promise<{ offeringId: string; resourceId: string }> }) {
  const { offeringId, resourceId } = await params;
  const url = new URL(request.url);
  const user = await requireUser(url.pathname + url.search);
  const missing = () => new Response(null, { status: 404, headers: privateHeaders });
  let source;
  try {
    source = await getCourseResourceFile(user.id, offeringId, resourceId);
  } catch (error) {
    if (error instanceof DomainError) return missing();
    throw error;
  }
  if (!source) return missing();
  if ('url' in source) {
    if (!URL.canParse(source.url)) return missing();
    const target = new URL(source.url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return missing();
    return new Response(null, { status: 307, headers: { ...privateHeaders, Location: target.href } });
  }
  const { bytes } = source;
  const name = source.name.replace(/[\\/\u0000-\u001f\u007f-\u009f]/gu, '_').toWellFormed() || '课程资料';
  const pdf = /\.pdf$/i.test(name) && new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-';
  const encodedName = encodeURIComponent(name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  const extension = name.match(/\.[a-z0-9]{1,12}$/i)?.[0] ?? '';
  const disposition = pdf && url.searchParams.get('download') !== '1' ? 'inline' : 'attachment';
  return new Response(new Uint8Array(bytes), { headers: {
    ...privateHeaders,
    'Content-Type': pdf ? 'application/pdf' : /\.txt$/i.test(name) ? 'text/plain; charset=utf-8' : 'application/octet-stream',
    'Content-Length': String(bytes.length),
    'Content-Disposition': `${disposition}; filename="resource${extension}"; filename*=UTF-8''${encodedName}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
  } });
}
