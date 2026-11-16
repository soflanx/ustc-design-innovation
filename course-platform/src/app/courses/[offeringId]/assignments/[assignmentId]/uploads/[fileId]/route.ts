import { getCurrentUser, requireSameOrigin } from '@/lib/auth';
import { DomainError } from '@/lib/management';
import { MAX_FORMAL_SUBMISSION_FILE_BYTES, SUBMISSION_CHUNK_BYTES } from '@/lib/submission-contract';
import { discardSubmissionUpload, saveSubmissionChunk, SubmissionUploadUnavailableError } from '@/lib/submission-upload-store';
import { requireSubmissionUploadAccess } from '@/lib/teaching';

const headers = { 'Cache-Control': 'private, no-store' };
const uploadId = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/;
type UploadRoute = { params: Promise<{ offeringId: string; assignmentId: string; fileId: string }> };

function fail(error: string, status: number, extra: { identityBlocked?: true; resetUpload?: true } = {}) {
  return Response.json({ error, ...extra }, { status, headers });
}

async function uploadUser(request: Request, originError: string) {
  try { await requireSameOrigin(); }
  catch { return fail(originError, 403); }
  const user = await getCurrentUser();
  if (!user) return fail('登录已过期。请重新登录原学生账号，再继续提交。', 401, { identityBlocked: true });
  if (request.headers.get('x-upload-user') !== encodeURIComponent(user.id)) {
    return fail('登录账号已切换，请切回原学生账号再继续提交。', 403, { identityBlocked: true });
  }
  return user;
}

export async function PUT(request: Request, { params }: UploadRoute) {
  const user = await uploadUser(request, '请从作业页面上传附件。');
  if (user instanceof Response) return user;
  const size = Number(request.headers.get('x-file-size'));
  const indexText = request.headers.get('x-chunk-index');
  const index = Number(indexText);
  const length = Math.min(SUBMISSION_CHUNK_BYTES, size - index * SUBMISSION_CHUNK_BYTES);
  let name: string;
  try { name = decodeURIComponent(request.headers.get('x-file-name') ?? ''); }
  catch { return fail('附件名称无效，请重新选择。', 400); }
  const { offeringId, assignmentId, fileId } = await params;
  if (!name || name.length > 255 || !uploadId.test(fileId)
    || !indexText || !/^(0|[1-9]\d*)$/.test(indexText) || !Number.isSafeInteger(index)
    || !Number.isSafeInteger(size) || size < 1 || size > MAX_FORMAL_SUBMISSION_FILE_BYTES || length < 1
    || !request.body || (request.headers.has('content-length') && Number(request.headers.get('content-length')) !== length)) {
    return fail('附件信息或分块大小不正确，请重新选择。', 400);
  }

  try {
    await requireSubmissionUploadAccess(user.id, offeringId, assignmentId);
    const reader = request.body.getReader();
    const bytes = new Uint8Array(length);
    let offset = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (offset + part.value.length > length) {
          await reader.cancel();
          return fail('收到的附件分块超过预期大小。', 400);
        }
        bytes.set(part.value, offset);
        offset += part.value.length;
      }
    } finally {
      reader.releaseLock();
    }
    if (offset !== length) return fail('附件分块还未传完整，请重试。', 400);
    const result = await saveSubmissionChunk(user.id, offeringId, assignmentId, fileId, { name, size, index, bytes });
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof SubmissionUploadUnavailableError) return fail(error.message, 409, { resetUpload: true });
    if (error instanceof DomainError) return fail(error.message, 409);
    console.error('作业附件上传失败', error instanceof Error ? error.name : 'UnknownError');
    return fail('附件上传暂未完成，请重试。', 503);
  }
}

export async function DELETE(request: Request, { params }: UploadRoute) {
  try {
    const user = await uploadUser(request, '请从作业页面移除附件。');
    if (user instanceof Response) return user;
    const { offeringId, assignmentId, fileId } = await params;
    if (!uploadId.test(fileId)) return fail('附件信息不正确。', 400);
    await discardSubmissionUpload(user.id, offeringId, assignmentId, fileId);
    return new Response(null, { status: 204, headers });
  } catch (error) {
    console.error('作业附件暂存清理失败', error instanceof Error ? error.name : 'UnknownError');
    return fail('暂未清除附件暂存，请重试。', 503);
  }
}
