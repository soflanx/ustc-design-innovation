import { requireUser } from '@/lib/auth';
import { DomainError } from '@/lib/management';
import { getSubmissionAttachment } from '@/lib/teaching';

const privateHeaders = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };

export async function GET(request: Request, { params }: { params: Promise<{
  offeringId: string; assignmentId: string; versionId: string; fileId: string;
}> }) {
  const { offeringId, assignmentId, versionId, fileId } = await params;
  const url = new URL(request.url);
  const user = await requireUser(url.pathname + url.search);
  const missing = () => new Response(null, { status: 404, headers: privateHeaders });
  let file;
  try { file = await getSubmissionAttachment(user.id, offeringId, assignmentId, versionId, fileId); }
  catch (error) { if (error instanceof DomainError) return missing(); throw error; }
  if (!file) return missing();
  const name = file.name.replace(/[\\/\u0000-\u001f\u007f-\u009f]/gu, '_').toWellFormed() || '成果附件';
  const pdf = /\.pdf$/i.test(name) && new TextDecoder().decode(file.bytes.subarray(0, 5)) === '%PDF-';
  const inline = pdf && url.searchParams.get('download') !== '1';
  const encodedName = encodeURIComponent(name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  const extension = name.match(/\.[a-z0-9]{1,12}$/i)?.[0] ?? '';
  return new Response(new Uint8Array(file.bytes), { headers: {
    ...privateHeaders,
    'Content-Type': pdf ? 'application/pdf' : 'application/octet-stream',
    'Content-Length': String(file.bytes.length),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="submission${extension}"; filename*=UTF-8''${encodedName}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
  } });
}
