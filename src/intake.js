import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { createHash } from 'node:crypto';

export const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readBoundedFile(path, maximum) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error(`Input must be a regular file of at most ${maximum} bytes.`);
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maximum) throw new Error('Input file exceeds the size limit.');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

export async function readManuscript(path) {
  if (!['.md', '.txt'].includes(extname(path).toLowerCase())) throw new Error('Manuscript must be a .md or .txt file.');
  const bytes = await readBoundedFile(path, 100000);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('Manuscript must contain valid UTF-8.'); }
  if (!text.trim() || text.includes('\0')) throw new Error('Manuscript is empty or contains binary data.');
  return { text, sha256: bytesHash(bytes) };
}

export async function readImage(path) {
  const bytes = await readBoundedFile(path, 10 * 1024 * 1024);
  const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR';
  const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) throw new Error('Image must have a PNG or JPEG signature.');
  return { bytes, sha256: bytesHash(bytes), mime: png ? 'image/png' : 'image/jpeg', extension: png ? 'png' : 'jpg' };
}

export function validateImported(title, body, config) {
  if (typeof title !== 'string' || !title.trim() || title.length > 300 || /[\r\n\0]/.test(title)) throw new Error('A single-line title of 1–300 characters is required.');
  if (typeof body !== 'string' || !body.trim() || body.includes('\0')) throw new Error('Manuscript is empty or invalid.');
  const text = `${body}\n\n---\n${config.disclosure}`;
  if (text.length > config.limits.maxBodyChars) throw new Error('Imported text including disclosure exceeds maxBodyChars; split the manuscript explicitly.');
  return { title, text, body };
}
