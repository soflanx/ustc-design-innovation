import { getPublishedNewsCover } from '@/lib/queries';
import { resourcePreviewHeaders } from '@/lib/resource-preview';

export async function GET(request: Request, { params }: { params: Promise<{ slug: string; imageId: string }> }) {
  const { slug, imageId } = await params;
  const cover = await getPublishedNewsCover(slug, imageId);
  if (!cover) return new Response(null, { status: 404, headers: resourcePreviewHeaders });
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(cover.bytes), { headers: {
    ...resourcePreviewHeaders,
    'Content-Type': cover.contentType,
    'Content-Length': String(cover.bytes.length),
    'Content-Security-Policy': "sandbox; default-src 'none'",
  } });
}
