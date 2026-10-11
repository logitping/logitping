import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/third-party-notices.mjs', import.meta.url));

/** The real script, run from a copy whose repository root is a temporary directory. */
describe('third-party notice generation', () => {
  let root: string;
  const run = () => execFileSync(process.execPath, [join(root, 'scripts', 'third-party-notices.mjs')], { stdio: 'pipe' });
  const writeMap = (sources: string[]) => writeFile(join(root, 'dist', 'index.js.map'), JSON.stringify({ version: 3, sources, mappings: '' }));
  const notices = () => join(root, 'dist', 'THIRD_PARTY_NOTICES.md');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'logitping-notices-'));
    await mkdir(join(root, 'scripts', 'embedded-licenses'), { recursive: true });
    await mkdir(join(root, 'dist'));
    await copyFile(script, join(root, 'scripts', 'third-party-notices.mjs'));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('lists each bundled package with its license text', async () => {
    const dependency = join(root, 'node_modules', 'bundled-dep');
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'bundled-dep', version: '1.2.3', license: 'MIT' }));
    await writeFile(join(dependency, 'LICENSE'), 'Synthetic license text\n');
    await writeMap(['../src/index.ts', '../node_modules/bundled-dep/index.js']);
    run();
    expect(await readFile(notices(), 'utf8')).toContain('\n## bundled-dep@1.2.3 (MIT)\n\nSynthetic license text\n');
  });

  it('fails instead of writing an empty notice list when no bundled package is recognized', async () => {
    await writeMap(['../src/index.ts']);
    expect(run).toThrow(/No bundled packages/);
    expect(existsSync(notices())).toBe(false);
  });
});
