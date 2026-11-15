import { SUBMISSION_CHUNK_BYTES } from './submission-contract';
import { isSubmissionUploadId } from './submission-draft';

export type ChosenSubmissionFile = { file: File };
type ChunkProgress = { id: string; receivedBytes: number; unavailable?: true };
export type SubmissionUploadProgress = WeakMap<ChosenSubmissionFile, ChunkProgress>;

export class SubmissionChunkError extends Error {
  constructor(message: string, readonly identityBlocked: boolean) {
    super(message);
  }
}

export const uploadReleaseFailed = '先前移除附件的暂存空间尚未释放。';

function isAssignmentHref(value: string | null): value is string {
  const match = value?.match(/^\/courses\/([^/]+)\/assignments\/([^/]+)$/);
  if (!match) return false;
  try {
    return match.slice(1).every(segment => segment !== '.' && segment !== '..'
      && encodeURIComponent(decodeURIComponent(segment)) === segment);
  } catch { return false; }
}

export class SubmissionUploadReleases {
  private readonly keyPrefix: string;
  private readonly pending = new Map<string, string>();
  private releasing: Promise<void> | undefined;

  constructor(private readonly assignmentHref: string, private readonly expectedUserId: string) {
    this.keyPrefix = `design-course:submission-upload-release:${encodeURIComponent(expectedUserId)}:`;
  }

  add(ids: readonly string[]) {
    for (const id of ids) {
      this.pending.set(id, this.assignmentHref);
      // One key per release lets two tabs queue removals without replacing each other's writes.
      try { localStorage.setItem(this.keyPrefix + id, this.assignmentHref); }
      catch { /* The queue can still retry in this tab. */ }
    }
  }

  async flush() {
    try {
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key?.startsWith(this.keyPrefix)) continue;
        const id = key.slice(this.keyPrefix.length);
        const assignmentHref = localStorage.getItem(key);
        if (isSubmissionUploadId(id) && isAssignmentHref(assignmentHref)) this.pending.set(id, assignmentHref);
      }
    } catch { /* Keep local requests when storage is unavailable. */ }
    while (this.pending.size) {
      this.releasing ??= this.releasePending().finally(() => { this.releasing = undefined; });
      await this.releasing;
    }
  }

  private async releasePending() {
    let failed = false;
    for (const [id, assignmentHref] of this.pending) {
      const response = await fetch(`${assignmentHref}/uploads/${encodeURIComponent(id.toLowerCase())}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        keepalive: true,
        headers: { 'x-upload-user': encodeURIComponent(this.expectedUserId) },
      }).catch(() => null);
      if (response?.status !== 204) {
        const result = await response?.json().catch(() => null);
        if (result?.identityBlocked === true || response?.status === 401) {
          throw new SubmissionChunkError(typeof result?.error === 'string' ? result.error : '请切回打开作业时的账号，再清理已移除的附件。', true);
        }
        failed = true;
        continue;
      }
      this.pending.delete(id);
      try { localStorage.removeItem(this.keyPrefix + id); }
      catch { /* A later request can safely repeat the release. */ }
    }
    if (failed) throw new SubmissionChunkError(uploadReleaseFailed, false);
  }
}

export async function stageSubmissionFiles(
  assignmentHref: string,
  expectedUserId: string,
  files: ChosenSubmissionFile[],
  progressByFile: SubmissionUploadProgress,
  reportProgress: (received: number) => void,
  recordUploadIds: () => void,
): Promise<string[]> {
  let previousBytes = 0;
  const ids: string[] = [];
  for (const choice of files) {
    const { file } = choice;
    let progress = progressByFile.get(choice);
    if (!progress) {
      progress = { id: crypto.randomUUID(), receivedBytes: 0 };
      progressByFile.set(choice, progress);
      recordUploadIds();
    }
    reportProgress(previousBytes + progress.receivedBytes);
    while (progress.receivedBytes < file.size) {
      const start = progress.receivedBytes;
      const end = Math.min(start + SUBMISSION_CHUNK_BYTES, file.size);
      const response = await fetch(`${assignmentHref}/uploads/${progress.id}`, {
        method: 'PUT',
        credentials: 'same-origin',
        redirect: 'error',
        headers: {
          'x-file-name': encodeURIComponent(file.name),
          'x-file-size': String(file.size),
          'x-chunk-index': String(start / SUBMISSION_CHUNK_BYTES),
          'x-upload-user': encodeURIComponent(expectedUserId),
        },
        body: file.slice(start, end),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        if (result?.resetUpload === true) {
          progressByFile.delete(choice);
          recordUploadIds();
        }
        const identityBlocked = result?.identityBlocked === true || response.status === 401;
        throw new SubmissionChunkError(typeof result?.error === 'string' ? result.error : '附件暂未上传，所选文件仍在。', identityBlocked);
      }
      if (!Number.isSafeInteger(result?.receivedBytes) || result.receivedBytes < end || result.receivedBytes > file.size) {
        throw new Error('Incomplete attachment upload receipt');
      }
      // An acknowledgement may cover later chunks after a retry. Advance
      // only through the bytes this browser has sent for the selected file.
      progress.receivedBytes = end;
      reportProgress(previousBytes + end);
    }
    previousBytes += file.size;
    ids.push(progress.id);
  }
  return ids;
}
