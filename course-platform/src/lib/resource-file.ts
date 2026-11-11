import { DomainError } from './management';
import { MAX_RESOURCE_FILE_BYTES } from './resource-file-limits';

// Keep download names usable in response headers and on common filesystems.
function safeFilename(name: string) {
  return name.replace(/[/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '-').trim();
}

export async function readResourceUpload(file?: File) {
  if (file === undefined) return null;
  if (!(file instanceof Blob) || typeof file.name !== 'string') throw new DomainError('请选择有效的课程文件。');
  if (!file.name && !file.size) return null; // An unselected HTML file input.
  const name = safeFilename(file.name);
  if (!name || name === '.' || name === '..' || name.length > 255) throw new DomainError('文件名无效或超过 255 个字符。');
  if (file.size > MAX_RESOURCE_FILE_BYTES) throw new DomainError('课程文件不能超过 10 MiB。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) throw new DomainError('文件读取不完整，请重新选择文件。');
  return { name, size: bytes.length, bytes };
}

export function legacyResourceFilename(title: string) {
  const name = safeFilename(title) || '课程资料';
  return /\.txt$/i.test(name) ? name : name + '.txt';
}
