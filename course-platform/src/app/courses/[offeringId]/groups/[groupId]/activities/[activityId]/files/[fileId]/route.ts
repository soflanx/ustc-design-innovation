import { requireUser } from '@/lib/auth';
import { getGroupActivityFile } from '@/lib/group-activities';
import { inlineFile, resourcePreviewHeaders } from '@/lib/resource-preview';

export async function GET(request: Request, { params }: { params: Promise<{
  offeringId: string; groupId: string; activityId: string; fileId: string;
}> }) {
  const { offeringId, groupId, activityId, fileId } = await params;
  const url = new URL(request.url);
  const user = await requireUser(url.pathname + url.search);
  const file = await getGroupActivityFile(user.id, offeringId, groupId, activityId, fileId);
  if (!file) return new Response(null, { status: 404, headers: resourcePreviewHeaders });

  const name = file.name.replace(/[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '_').toWellFormed() || '小组材料';
  const inline = url.searchParams.get('download') === '1' ? undefined : inlineFile(name, file.bytes);
  const encodedName = encodeURIComponent(name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  const extension = name.match(/\.[a-z0-9]{1,12}$/i)?.[0] ?? '';
  return new Response(new Uint8Array(file.bytes), { headers: {
    ...resourcePreviewHeaders,
    'Content-Type': inline?.contentType ?? 'application/octet-stream',
    'Content-Length': String(file.bytes.length),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="material${extension}"; filename*=UTF-8''${encodedName}`,
    'Content-Security-Policy': "sandbox; default-src 'none'",
  } });
}
