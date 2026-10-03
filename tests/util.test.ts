import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBoundedText, syncDirectory } from '../src/util/fs.js';

describe('bounded file reads', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'logitping-util-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('reads files within the limit and rejects larger files and directories', async () => {
    const path = join(directory, 'input.json');
    await writeFile(path, '{"ok":true}');
    expect(await readBoundedText(path, 11, 'too large')).toBe('{"ok":true}');
    await expect(readBoundedText(path, 10, 'too large')).rejects.toThrow('too large');
    await expect(readBoundedText(directory, 1_000, 'too large')).rejects.toThrow('too large');
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for a writer', async () => {
    const fifo = join(directory, 'input.fifo');
    execFileSync('mkfifo', [fifo]);
    await expect(readBoundedText(fifo, 1_000, 'not a regular file')).rejects.toThrow('not a regular file');
  });

  it('syncs a directory after a rename', async () => {
    await expect(syncDirectory(directory)).resolves.toBeUndefined();
  });
});
