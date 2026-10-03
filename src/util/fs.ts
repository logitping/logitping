import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

/** Read-only open that returns immediately for a FIFO, so the regular-file check can reject it. */
export const READ_NONBLOCKING = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

export function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

/** Read a regular file, checking its size before loading it into memory. `tooLarge` also covers non-files. */
export async function readBoundedText(path: string, maxBytes: number, tooLarge: string | (() => Error)): Promise<string> {
  const rejected = () => typeof tooLarge === 'string' ? new Error(tooLarge) : tooLarge();
  const file = await open(path, READ_NONBLOCKING);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw rejected();
    const text = await file.readFile('utf8');
    if (Buffer.byteLength(text) > maxBytes) throw rejected();
    return text;
  } finally { await file.close(); }
}

/** Make a completed rename durable across power loss. */
export async function syncDirectory(path: string): Promise<void> {
  let directory: FileHandle | undefined;
  try {
    directory = await open(path, 'r');
    await directory.sync();
  } catch (error) {
    // Windows and some filesystems cannot sync directories; only an I/O error means lost data.
    if (errorCode(error) === 'EIO') throw error;
  } finally { await directory?.close(); }
}
