import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db } from './db';
import { DomainError } from './management';
import {
  MAX_FORMAL_SUBMISSION_FILE_BYTES, MAX_SUBMISSION_FILES, SUBMISSION_CHUNK_BYTES,
} from './submission-contract';

type Tx = Prisma.TransactionClient;
type ChunkInput = { name: string; size: number; index: number; bytes: Uint8Array };
type FileHeader = { id: string; name: string; size: bigint };
type UploadState = { fileId: string; receivedBytes: number; digest: string | null; expiresAt: Date; consumedAt: Date | null };
type StagedAttachment = {
  id: string; name: string; size: number; digest: string; alreadySubmitted: boolean; expired: boolean;
};

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const uploadTtlMs = 24 * 60 * 60 * 1000;
// Keep room for two concurrent drafts while limiting the disk a single
// student can reserve before submitting anything.
const stagingBytesPerUser = 2 * MAX_FORMAL_SUBMISSION_FILE_BYTES;
const stagedFilesPerUser = 2 * MAX_SUBMISSION_FILES;
const unreferencedFile = {
  submissions: { none: {} }, groupActivities: { none: {} }, showcaseMaterials: { none: {} },
} satisfies Prisma.FileObjectWhereInput;

export class SubmissionUploadUnavailableError extends DomainError {
  constructor() {
    super('有附件尚未传完或暂存已过期，请重新上传后提交。');
  }
}

function chunkValues(fileId: string, input: ChunkInput) {
  if (typeof fileId !== 'string' || !uuid.test(fileId)) throw new SubmissionUploadUnavailableError();
  const { size, index, bytes } = input;
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FORMAL_SUBMISSION_FILE_BYTES
    || !Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(size / SUBMISSION_CHUNK_BYTES)) {
    throw new DomainError('附件大小或分块序号无效。');
  }
  const offset = index * SUBMISSION_CHUNK_BYTES;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== Math.min(SUBMISSION_CHUNK_BYTES, size - offset)) {
    throw new DomainError('附件分块不完整，请重试上传。');
  }
  const name = typeof input.name === 'string'
    ? input.name.replace(/[/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '-').trim() : '';
  if (!name || name === '.' || name === '..' || name.length > 255 || !name.isWellFormed()) {
    throw new DomainError('文件名无效或超过 255 个字符。');
  }
  return { id: fileId.toLowerCase(), name, offset };
}

async function lockUser(tx: Tx, userId: string) {
  const users = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
  return users.length > 0;
}

async function lockFiles(tx: Tx, userId: string, offeringId: string, ids: string[]) {
  return tx.$queryRaw<FileHeader[]>`
    SELECT "id", "originalName" AS "name", "sizeBytes" AS "size"
    FROM "FileObject"
    WHERE "id" IN (${Prisma.join(ids)}) AND "ownerId" = ${userId} AND "offeringId" = ${offeringId} AND "chunked"
    ORDER BY "id"
    FOR NO KEY UPDATE
  `;
}

async function lockUploads(tx: Tx, offeringId: string, assignmentId: string, ids: string[]) {
  return tx.$queryRaw<UploadState[]>`
    SELECT "fileId", "receivedBytes", "digest", "expiresAt", "consumedAt"
    FROM "SubmissionUpload"
    WHERE "fileId" IN (${Prisma.join(ids)}) AND "offeringId" = ${offeringId} AND "assignmentId" = ${assignmentId}
    ORDER BY "fileId"
    FOR UPDATE
  `;
}

async function clearExpiredUploads(tx: Tx, now: Date) {
  // New uploads sweep a bounded batch, including uploads abandoned by users
  // who never return. Skip files currently being written or finalized.
  const candidates = await tx.$queryRaw<{ id: string }[]>`
    SELECT f."id" FROM "SubmissionUpload" u JOIN "FileObject" f ON f."id" = u."fileId"
    WHERE u."expiresAt" <= ${now} AND u."consumedAt" IS NULL
    ORDER BY u."expiresAt", u."fileId"
    LIMIT 20
    FOR UPDATE OF f SKIP LOCKED
  `;
  if (!candidates.length) return;
  // A prior writer may have renewed the lease just before we locked its file.
  // Recheck against a fresh snapshot while holding those locks.
  await tx.fileObject.deleteMany({ where: {
    id: { in: candidates.map(file => file.id) },
    submissionUpload: { expiresAt: { lte: now }, consumedAt: null },
    ...unreferencedFile,
  } });
}

async function clearExpiredUploadDiscards(tx: Tx, now: Date) {
  await tx.$executeRaw`
    WITH expired AS (
      SELECT "ownerId", "offeringId", "assignmentId", "fileId"
      FROM "SubmissionUploadDiscard"
      WHERE "expiresAt" <= ${now}
      ORDER BY "expiresAt"
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "SubmissionUploadDiscard" d USING expired e
    WHERE (d."ownerId", d."offeringId", d."assignmentId", d."fileId") =
          (e."ownerId", e."offeringId", e."assignmentId", e."fileId")
      AND d."expiresAt" <= ${now}
  `;
}

async function reserveFile(tx: Tx, userId: string, offeringId: string, assignmentId: string, id: string, name: string, size: number, now: Date) {
  await clearExpiredUploads(tx, now);
  await clearExpiredUploadDiscards(tx, now);
  const [usage] = await tx.$queryRaw<{ count: bigint; size: bigint }[]>`
    SELECT COUNT(*) AS "count", COALESCE(SUM(f."sizeBytes"), 0)::bigint AS "size"
    FROM "SubmissionUpload" u JOIN "FileObject" f ON f."id" = u."fileId"
    WHERE f."ownerId" = ${userId} AND u."consumedAt" IS NULL AND u."expiresAt" > ${now}
  `;
  if (Number(usage.count) >= stagedFilesPerUser || Number(usage.size) + size > stagingBytesPerUser) {
    throw new DomainError('暂存附件已达上限，请先完成已有的提交或等待暂存到期。');
  }
  const created = await tx.fileObject.createMany({
    data: {
      id, offeringId, ownerId: userId, originalName: name, sizeBytes: size,
      storageKey: randomUUID(), mimeType: 'application/octet-stream', chunked: true,
    },
    skipDuplicates: true,
  });
  if (!created.count) throw new SubmissionUploadUnavailableError();
  return tx.submissionUpload.create({
    data: { fileId: id, offeringId, assignmentId, expiresAt: new Date(now.getTime() + uploadTtlMs) },
  });
}

export async function discardSubmissionUpload(userId: string, offeringId: string, assignmentId: string, fileId: string): Promise<void> {
  if (typeof fileId !== 'string' || !uuid.test(fileId)) throw new SubmissionUploadUnavailableError();
  const id = fileId.toLowerCase();
  await db.$transaction(async tx => {
    if (!await lockUser(tx, userId)) return;
    const [file] = await lockFiles(tx, userId, offeringId, [id]);
    if (file) {
      const [upload] = await lockUploads(tx, offeringId, assignmentId, [id]);
      if (!upload || upload.consumedAt) return;
      const deleted = await tx.fileObject.deleteMany({ where: { id, ...unreferencedFile } });
      if (!deleted.count) return;
    } else {
      const assignment = await tx.assignment.findFirst({
        where: { id: assignmentId, offeringId, offering: { members: { some: { userId, role: 'STUDENT', status: 'ACTIVE' } } } },
        select: { id: true },
      });
      if (!assignment) return;
    }

    // The first PUT may still be reading its request body when DELETE runs.
    // Remember the discarded ID in the same scope and transaction as the release.
    const scope = { ownerId: userId, offeringId, assignmentId, fileId: id };
    const now = new Date();
    const expiresAt = new Date(now.getTime() + uploadTtlMs);
    await tx.submissionUploadDiscard.upsert({
      where: { ownerId_offeringId_assignmentId_fileId: scope },
      create: { ...scope, expiresAt },
      update: { expiresAt },
    });
    await clearExpiredUploadDiscards(tx, now);
  });
}

export async function saveSubmissionChunk(userId: string, offeringId: string, assignmentId: string, fileId: string, input: ChunkInput): Promise<{ receivedBytes: number }> {
  const { id, name, offset } = chunkValues(fileId, input);
  const { size, index, bytes } = input;
  // The caller checks current submission permission. Keep upload scope and
  // reservation limits valid through concurrent requests for this account.
  return db.$transaction(async tx => {
    if (!await lockUser(tx, userId)) throw new SubmissionUploadUnavailableError();
    const [file] = await lockFiles(tx, userId, offeringId, [id]);
    const now = new Date();
    let upload: UploadState | undefined;
    if (file) {
      if (file.name !== name || file.size !== BigInt(size)) throw new SubmissionUploadUnavailableError();
      [upload] = await lockUploads(tx, offeringId, assignmentId, [id]);
      if (!upload || (!upload.consumedAt && upload.expiresAt <= now)) throw new SubmissionUploadUnavailableError();
    } else {
      if (index !== 0) throw new SubmissionUploadUnavailableError();
      const discarded = await tx.submissionUploadDiscard.findUnique({
        where: { ownerId_offeringId_assignmentId_fileId: { ownerId: userId, offeringId, assignmentId, fileId: id } },
        select: { expiresAt: true },
      });
      if (discarded && discarded.expiresAt > now) throw new SubmissionUploadUnavailableError();
      upload = await reserveFile(tx, userId, offeringId, assignmentId, id, name, size, now);
    }

    if (offset < upload.receivedBytes) {
      const previous = await tx.fileObjectChunk.findUnique({
        where: { fileId_index: { fileId: id, index } }, select: { bytes: true },
      });
      if (!previous || previous.bytes.length !== bytes.length || !timingSafeEqual(previous.bytes, bytes)) {
        throw new DomainError('本次选取的文件与已上传的内容不同，请重新选择。');
      }
      return { receivedBytes: upload.receivedBytes };
    }
    if (offset !== upload.receivedBytes || upload.consumedAt) throw new SubmissionUploadUnavailableError();
    const hash = createHash('sha256');
    if (upload.digest) hash.update(Buffer.from(upload.digest, 'hex'));
    const digest = hash.update(createHash('sha256').update(bytes).digest()).digest('hex');
    const receivedBytes = offset + bytes.byteLength;
    await tx.fileObjectChunk.create({ data: { fileId: id, index, bytes: Uint8Array.from(bytes) } });
    await tx.submissionUpload.update({
      where: { fileId: id }, data: { receivedBytes, digest, expiresAt: new Date(now.getTime() + uploadTtlMs) },
    });
    return { receivedBytes };
  });
}

export async function loadStagedSubmissionFiles(tx: Tx, userId: string, offeringId: string, assignmentId: string, ids: string[]): Promise<StagedAttachment[]> {
  if (!ids.length) return [];
  if (ids.length > MAX_SUBMISSION_FILES || ids.some(id => typeof id !== 'string' || !uuid.test(id))) {
    throw new SubmissionUploadUnavailableError();
  }
  const keys = ids.map(id => id.toLowerCase());
  if (new Set(keys).size !== keys.length) throw new SubmissionUploadUnavailableError();
  const files = await lockFiles(tx, userId, offeringId, keys);
  if (files.length !== keys.length) throw new SubmissionUploadUnavailableError();
  const uploads = await lockUploads(tx, offeringId, assignmentId, keys);
  const filesById = new Map(files.map(file => [file.id, file]));
  const uploadsById = new Map(uploads.map(upload => [upload.fileId, upload]));
  const now = new Date();
  return keys.map(id => {
    const file = filesById.get(id)!;
    const upload = uploadsById.get(id);
    if (!upload?.digest || BigInt(upload.receivedBytes) !== file.size) throw new SubmissionUploadUnavailableError();
    return {
      id, name: file.name, size: upload.receivedBytes, digest: upload.digest,
      alreadySubmitted: !!upload.consumedAt, expired: upload.expiresAt <= now,
    };
  });
}

export async function markStagedFilesSubmitted(tx: Tx, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const now = new Date();
  const changed = await tx.submissionUpload.updateMany({
    where: { fileId: { in: ids }, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  if (changed.count !== ids.length) throw new SubmissionUploadUnavailableError();
  // A stale snapshot attempting to write a chunk must conflict on the same
  // file-row lock even before it can see the newly finalized submission.
  await tx.fileObject.updateMany({ where: { id: { in: ids }, chunked: true }, data: { chunked: true } });
}
