import type { CourseResourceFile } from './resource-service';

const textLimit = 50_000;
const downloadOnly = /\.(?:html?|xhtml|shtml|mhtml?|svgz?|xml|doc[xm]?|dot[xm]?|xls[xmb]?|xlt[xm]?|ppt[xm]?|pot[xm]?|pps[xm]?|od[tspg]|rtf|pages|numbers|key|wps)$/i;
const markup = /<(?:!--|\?xml\b|!doctype\b|\/?(?:html|head|body|title|script|style|meta|iframe|frame|svg|object|embed|link|img|form|input|button|a|div|span|p|table|h[1-6])(?=[\s/>]))/i;

export const resourcePreviewHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

type PreviewFile = { name: string; size: number; href: string };
type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export type ResourcePreview =
  | (PreviewFile & { kind: 'pdf'; contentType: 'application/pdf' })
  | (PreviewFile & { kind: 'image'; contentType: ImageType })
  | (PreviewFile & { kind: 'text'; contentType: 'text/plain; charset=utf-8'; text: string; truncated: boolean })
  | (PreviewFile & { kind: 'download' })
  | (PreviewFile & { kind: 'link' });

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function inlineFile(name: string, bytes: Uint8Array) {
  if (downloadOnly.test(name)) return;
  const header = String.fromCharCode(...bytes.subarray(0, 16));
  if (/\.pdf$/i.test(name) && /^%PDF-\d\.\d/.test(header)) return { kind: 'pdf', contentType: 'application/pdf', extension: 'pdf' } as const;
  if (pngSignature.every((byte, index) => bytes[index] === byte)) return { kind: 'image', contentType: 'image/png', extension: 'png' } as const;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: 'image', contentType: 'image/jpeg', extension: 'jpg' } as const;
  if (/^GIF8[79]a/.test(header)) return { kind: 'image', contentType: 'image/gif', extension: 'gif' } as const;
  if (header.startsWith('RIFF') && /^WEBPVP8[ LX]$/.test(header.slice(8))) return { kind: 'image', contentType: 'image/webp', extension: 'webp' } as const;
}

function plainText(name: string, bytes: Uint8Array) {
  if (downloadOnly.test(name) || /\.pdf$/i.test(name) || String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') return;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return; }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text) || markup.test(text)) return;
  let count = 0, end = 0;
  for (const character of text) {
    if (count === textLimit) return { text: text.slice(0, end), truncated: true };
    end += character.length;
    count++;
  }
  return { text, truncated: false };
}

function metadata(result: ResourcePreview) {
  return Response.json(result, { headers: resourcePreviewHeaders });
}

export function resourcePreviewResponse(source: CourseResourceFile, offeringId: string, resourceId: string, meta: boolean) {
  const href = `/courses/${encodeURIComponent(offeringId)}/resources/${encodeURIComponent(resourceId)}/open`;
  const unsupported = () => new Response(null, { status: 415, headers: resourcePreviewHeaders });
  if ('url' in source) return meta ? metadata({ kind: 'link', name: '资料链接', size: 0, href }) : unsupported();

  const { bytes } = source;
  const name = source.name.replace(/[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '_').toWellFormed() || '课程资料';
  const inline = inlineFile(name, bytes);
  if (!meta) {
    if (!inline) return unsupported();
    const encodedName = encodeURIComponent(name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
    return new Response(new Uint8Array(bytes), { headers: {
      ...resourcePreviewHeaders,
      'Content-Type': inline.contentType,
      'Content-Length': String(bytes.length),
      'Content-Disposition': `inline; filename="resource.${inline.extension}"; filename*=UTF-8''${encodedName}`,
      'Content-Security-Policy': "frame-ancestors 'self'",
    } });
  }

  const file = { name, size: bytes.length, href };
  if (inline) return metadata({ ...file, kind: inline.kind, contentType: inline.contentType } as ResourcePreview);
  const text = plainText(name, bytes);
  return text
    ? metadata({ ...file, kind: 'text', contentType: 'text/plain; charset=utf-8', ...text })
    : metadata({ ...file, kind: 'download' });
}
