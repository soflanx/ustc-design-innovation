import { inlineFile, resourcePreviewHeaders } from './resource-preview';
import { readStoredFileHeader, streamStoredFile, type StoredFile } from './stored-file';

function requestedRange(range: string | null, size: number) {
  const match = range?.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return;
  const length = BigInt(size);
  const first = match[1] ? BigInt(match[1]) : null;
  const last = match[2] ? BigInt(match[2]) : null;
  if (first === null) {
    if (!last || !length) return null;
    return { start: Number(last >= length ? 0n : length - last), endExclusive: size };
  }
  if (first >= length || (last !== null && last < first)) return null;
  return { start: Number(first), endExclusive: last === null || last + 1n >= length ? size : Number(last + 1n) };
}

export async function attachmentResponse(request: Request, file: StoredFile, origin: 'submission' | 'showcase') {
  const url = new URL(request.url);
  const name = file.name.replace(/[\\/\p{Cc}\p{Bidi_Control}]/gu, '_').toWellFormed().trim()
    || (origin === 'submission' ? '成果附件' : '项目材料');
  const mayUseRange = request.method === 'GET' && !request.headers.has('if-range');
  const range = requestedRange(mayUseRange ? request.headers.get('range') : null, file.size);
  if (range === null) return new Response(null, {
    status: 416, headers: { ...resourcePreviewHeaders, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${file.size}` },
  });

  const download = url.searchParams.get('download') === '1';
  const recognizeImage = origin === 'showcase' ? !download : url.searchParams.get('preview') === '1';
  const header = origin === 'showcase' && download ? null : await readStoredFileHeader(file);
  const pdf = origin === 'submission' && /\.pdf$/i.test(name) && header
    && String.fromCharCode(...header.subarray(0, 5)) === '%PDF-';
  const recognized = header && recognizeImage ? inlineFile(name, header) : null;
  const type = pdf ? 'application/pdf' : recognized?.contentType;
  const encodedName = encodeURIComponent(name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  const extension = name.match(/\.[a-z0-9]{1,12}$/i)?.[0] ?? '';
  const fallback = origin === 'submission' ? 'submission' : 'material';
  return new Response(request.method === 'HEAD' ? null : streamStoredFile(file, range), {
    status: range ? 206 : 200,
    headers: {
      ...resourcePreviewHeaders,
      'Accept-Ranges': 'bytes',
      'Content-Type': type ?? 'application/octet-stream',
      'Content-Length': String(range ? range.endExclusive - range.start : file.size),
      'Content-Disposition': `${type && !download ? 'inline' : 'attachment'}; filename="${fallback}${extension}"; filename*=UTF-8''${encodedName}`,
      'Content-Security-Policy': "sandbox; default-src 'none'",
      ...(range ? { 'Content-Range': `bytes ${range.start}-${range.endExclusive - 1}/${file.size}` } : {}),
    },
  });
}
