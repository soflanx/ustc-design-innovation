import { getCurrentUser } from '@/lib/auth';
import { DomainError } from '@/lib/management';
import { resourcePreviewHeaders, resourcePreviewResponse } from '@/lib/resource-preview';
import { getCourseResourceFile } from '@/lib/resource-service';

export async function GET(request: Request, { params }: { params: Promise<{ offeringId: string; resourceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response(null, { status: 401, headers: resourcePreviewHeaders });
  const { offeringId, resourceId } = await params;
  const missing = () => new Response(null, { status: 404, headers: resourcePreviewHeaders });
  try {
    const file = await getCourseResourceFile(user.id, offeringId, resourceId);
    if (!file) return missing();
    const meta = new URL(request.url).searchParams.get('meta') === '1';
    return resourcePreviewResponse(file, offeringId, resourceId, meta);
  } catch (error) {
    if (error instanceof DomainError) return missing();
    throw error;
  }
}
