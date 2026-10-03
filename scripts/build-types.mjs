import { rollup } from 'rollup';
import { dts } from 'rollup-plugin-dts';

// Generate declarations on the main thread using Rollup's WebAssembly build.
const bundle = await rollup({
  input: 'src/index.ts',
  plugins: [dts({ tsconfig: 'tsconfig.json' })],
});
try {
  // Both entry points expose the same named exports. The extensions let
  // TypeScript resolve the declarations with the correct ESM/CommonJS identity.
  await bundle.write({ file: 'dist/index.d.ts', format: 'es' });
  await bundle.write({ file: 'dist/index.d.cts', format: 'es' });
} finally {
  await bundle.close();
}
