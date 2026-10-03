import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The published bundles inline their runtime dependencies, so their license notices must ship too.
// Source maps list every bundled module; they are build outputs and are not published themselves.
const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
// License texts of packages that a dependency bundled into its own build, so they are not installed.
const embedded = join(root, 'scripts', 'embedded-licenses');
const maps = (await readdir(dist, { recursive: true })).filter((path) => path.endsWith('.map')).map((path) => join(dist, path));
if (!maps.length) throw new Error('No source maps in dist; build before generating third-party notices');

const exists = (path) => access(path).then(() => true, () => false);
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.-]|$)/i;

/** name@version -> { license, text } */
const notices = new Map();
for (const map of maps) {
  for (const source of JSON.parse(await readFile(map, 'utf8')).sources) {
    // Greedy: the last node_modules segment is the package that owns a nested dependency's file.
    const directory = resolve(dirname(map), source).match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
    if (!directory) continue;
    const [, path, packageName] = directory;
    if (await exists(join(path, 'package.json'))) {
      const { name, version, license } = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      if (notices.has(`${name}@${version}`)) continue;
      const file = (await readdir(path)).find((entry) => LICENSE_FILE.test(entry));
      if (!file) throw new Error(`${name}@${version} ships no license file; add ${name}@${version}.txt to scripts/embedded-licenses and handle it here`);
      notices.set(`${name}@${version}`, { license, text: await readFile(join(path, file), 'utf8') });
      continue;
    }
    // A path from a dependency's own build (for example .pnpm/name@version/...): the code is
    // inlined in that dependency's distribution, so its notice comes from a vendored copy.
    const version = path.match(/\.pnpm\/(?:@[^/+]+\+)?[^/@]+@([^/_]+)/)?.[1];
    if (!version) throw new Error(`Cannot identify the bundled package for ${source}`);
    const id = `${packageName}@${version}`;
    if (notices.has(id)) continue;
    const vendored = join(embedded, `${id}.txt`);
    if (!(await exists(vendored))) throw new Error(`${id} is embedded by a dependency; add its license text as scripts/embedded-licenses/${id}.txt`);
    notices.set(id, { license: 'embedded in a dependency\'s build', text: await readFile(vendored, 'utf8') });
  }
}

let output = '# Third-party notices\n\nThe files in this package bundle the following software.\n';
for (const [id, { license, text }] of [...notices].sort(([a], [b]) => a.localeCompare(b))) {
  output += `\n## ${id} (${license})\n\n${text.trim()}\n`;
}
await writeFile(join(dist, 'THIRD_PARTY_NOTICES.md'), output);
