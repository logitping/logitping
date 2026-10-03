import { defineConfig, type Options } from 'tsup';

const esmRequire = 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);';

const shared = {
  target: 'node22',
  platform: 'node',
  splitting: false,
  // ESM-only dependencies must be bundled for CommonJS consumers: Node 22 before 22.12 cannot require() ESM.
  noExternal: [/./],
  // Maps point at the repository sources; embedding them would duplicate the bank. They are
  // build outputs for debugging and third-party notices, excluded from the published package.
  esbuildOptions(options) { options.sourcesContent = false; },
} satisfies Options;

export default defineConfig([
  {
    ...shared,
    // One ESM build so the library and CLI share a chunk: the bank and engine ship once for both.
    entry: { index: 'src/index.ts', 'bin/logitping': 'bin/logitping.js' },
    format: ['esm'],
    splitting: true,
    // Declarations run in scripts/build-types.mjs without worker permissions.
    dts: false,
    sourcemap: true,
    banner: { js: esmRequire },
  },
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    format: ['cjs'],
    dts: false,
    sourcemap: true,
  },
  {
    ...shared,
    // Maintainer tooling for scripts/update-bank.mjs; outside dist, so never published.
    entry: { maintainer: 'src/maintainer.ts' },
    outDir: 'build',
    format: ['esm'],
    banner: { js: esmRequire },
  },
]);
