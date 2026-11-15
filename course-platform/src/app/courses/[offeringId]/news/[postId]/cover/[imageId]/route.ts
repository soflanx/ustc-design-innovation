import { getCurrentUser } from '@/lib/auth';
import { getCourseNewsDraftCover } from '@/lib/course-news';
import { resourcePreviewHeaders } from '@/lib/resource-preview';

export async function GET(request: Request, { params }: { params: Promise<{ offeringId: string; postId: string; imageId: string }> }) {
  const { offeringId, postId, imageId } = await params;
  const viewer = await getCurrentUser();
  const cover = viewer ? await getCourseNewsDraftCover(viewer.id, offeringId, postId, imageId) : null;
  if (!cover) return new Response(null, { status: 404, headers: resourcePreviewHeaders });
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(cover.bytes), { headers: {
    ...resourcePreviewHeaders,
    'Content-Type': cover.contentType,
    'Content-Length': String(cover.bytes.length),
    'Content-Security-Policy': "sandbox; default-src 'none'",
  } });
}
