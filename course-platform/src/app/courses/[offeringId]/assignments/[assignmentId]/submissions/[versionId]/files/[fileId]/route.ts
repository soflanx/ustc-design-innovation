import { requireUser } from '@/lib/auth';
import { attachmentResponse } from '@/lib/attachment-response';
import { DomainError } from '@/lib/management';
import { resourcePreviewHeaders } from '@/lib/resource-preview';
import { getSubmissionAttachment } from '@/lib/teaching';

export async function GET(request: Request, { params }: { params: Promise<{
  offeringId: string; assignmentId: string; versionId: string; fileId: string;
}> }) {
  const { offeringId, assignmentId, versionId, fileId } = await params;
  const url = new URL(request.url);
  const user = await requireUser(url.pathname + url.search);
  const missing = () => new Response(null, { status: 404, headers: resourcePreviewHeaders });
  let file;
  try { file = await getSubmissionAttachment(user.id, offeringId, assignmentId, versionId, fileId); }
  catch (error) { if (error instanceof DomainError) return missing(); throw error; }
  return file ? attachmentResponse(request, file, 'submission') : missing();
}
