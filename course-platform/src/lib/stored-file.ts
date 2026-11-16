import { Prisma } from '@prisma/client';
import { db } from './db';
import { SUBMISSION_CHUNK_BYTES } from './submission-contract';

export const storedFileSelect = {
  id: true, originalName: true, sizeBytes: true, bytes: true, chunked: true,
} as const satisfies Prisma.FileObjectSelect;

export type StoredFile = { id: string; name: string; size: number } & (
  | { chunked: true }
  | { chunked: false; bytes: Uint8Array }
);

type StoredFileRow = Prisma.FileObjectGetPayload<{ select: typeof storedFileSelect }>;
type ChunkedFile = Extract<StoredFile, { chunked: true }>;
type ByteRange = { start: number; endExclusive: number };

export function storedFileFromRow(row: StoredFileRow): StoredFile | null {
  if (row.chunked) {
    const size = Number(row.sizeBytes);
    if (!Number.isSafeInteger(size) || size <= 0) return null;
    return { id: row.id, name: row.originalName, size, chunked: true };
  }
  if (!row.bytes) return null;
  // Older rows already used the actual byte length for delivery.
  return { id: row.id, name: row.originalName, size: row.bytes.length, chunked: false, bytes: row.bytes };
}

function expectedChunkSize(file: ChunkedFile, index: number) {
  return Math.min(SUBMISSION_CHUNK_BYTES, file.size - index * SUBMISSION_CHUNK_BYTES);
}

async function readChunk(file: ChunkedFile, index: number) {
  const chunk = await db.fileObjectChunk.findUnique({
    where: { fileId_index: { fileId: file.id, index } }, select: { bytes: true },
  });
  if (!chunk || chunk.bytes.length !== expectedChunkSize(file, index)) {
    throw new Error('Stored course attachment is incomplete');
  }
  return chunk.bytes;
}

export async function readStoredFileHeader(file: StoredFile): Promise<Uint8Array> {
  if (!file.chunked) return file.bytes.subarray(0, 16);
  const [chunk] = await db.$queryRaw<{ bytes: Uint8Array; size: number }[]>(Prisma.sql`
    SELECT substring("bytes" FROM 1 FOR 16) AS "bytes", octet_length("bytes") AS "size"
    FROM "FileObjectChunk" WHERE "fileId" = ${file.id} AND "index" = 0
  `);
  if (!chunk || chunk.size !== expectedChunkSize(file, 0)) throw new Error('Stored course attachment is incomplete');
  return chunk.bytes;
}

/** Open an already authorized file after the access query has completed. */
export function streamStoredFile(file: StoredFile, range: ByteRange = { start: 0, endExclusive: file.size }) {
  let offset = range.start;
  let cancelled = false;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      if (offset >= range.endExclusive) {
        controller.close();
        return;
      }
      if (!file.chunked) {
        controller.enqueue(new Uint8Array(file.bytes.subarray(offset, range.endExclusive)));
        controller.close();
        return;
      }
      const index = Math.floor(offset / SUBMISSION_CHUNK_BYTES);
      const chunkStart = index * SUBMISSION_CHUNK_BYTES;
      const chunk = await readChunk(file, index);
      if (cancelled) return;
      const end = Math.min(chunkStart + chunk.length, range.endExclusive);
      controller.enqueue(new Uint8Array(chunk.subarray(offset - chunkStart, end - chunkStart)));
      offset = end;
      if (offset === range.endExclusive) controller.close();
    },
    cancel() { cancelled = true; },
  });
}
