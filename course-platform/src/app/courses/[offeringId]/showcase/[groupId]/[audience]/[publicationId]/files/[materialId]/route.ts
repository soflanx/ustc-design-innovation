import { getCurrentUser } from '@/lib/auth';
import { attachmentResponse } from '@/lib/attachment-response';
import { getPublishedGroupShowcaseFile } from '@/lib/group-showcase';
import { resourcePreviewHeaders } from '@/lib/resource-preview';

export async function GET(request: Request, { params }: { params: Promise<{
  offeringId: string; groupId: string; audience: string; publicationId: string; materialId: string;
}> }) {
  const { offeringId, groupId, audience, publicationId, materialId } = await params;
  const missing = () => new Response(null, { status: 404, headers: resourcePreviewHeaders });
  const scope = audience === 'class' ? 'CLASS' : audience === 'public' ? 'PUBLIC' : null;
  if (!scope) return missing();
  const viewer = scope === 'CLASS' ? await getCurrentUser() : null;
  if (scope === 'CLASS' && !viewer) return missing();
  const file = await getPublishedGroupShowcaseFile(offeringId, groupId, scope, publicationId, materialId, viewer?.id);
  return file ? attachmentResponse(request, file, 'showcase') : missing();
}
