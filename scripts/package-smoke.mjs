import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'logitping-package-'));
try {
  // npm 10 still runs prepare despite --ignore-scripts; capture lifecycle output
  // inside npm so build logs cannot contaminate the pack command's JSON stdout.
  const output = execFileSync('npm', ['pack', '--ignore-scripts', '--foreground-scripts=false', '--json', '--pack-destination', directory], { cwd: root, encoding: 'utf8' });
  const [packed] = JSON.parse(output);
  const packedFiles = packed.files.map((file) => file.path);
  // Maps reference unpublished sources; the bundled dependencies' notices must ship.
  assert.deepEqual(packedFiles.filter((path) => path.endsWith('.map')), []);
  // The ESM library and CLI share exactly one chunk; another is left over from an earlier build.
  assert.equal(packedFiles.filter((path) => /^dist\/chunk-[^/]+\.js$/.test(path)).length, 1, 'stale build chunks would be published');
  assert.ok(packedFiles.includes('dist/THIRD_PARTY_NOTICES.md'));
  execFileSync('npm', ['install', '--global', '--prefix', directory, '--offline', '--ignore-scripts', '--cache', process.env.npm_config_cache ?? join(homedir(), '.npm'), join(directory, packed.filename)], { stdio: 'pipe' });
  for (const command of ['logitping', 'lping']) {
    const executable = join(directory, 'bin', command);
    assert.match(execFileSync(executable, ['--help'], { encoding: 'utf8' }), /--driver/);
    const result = spawnSync(executable, ['--json', '--no-interactive'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).status, 'ERROR');
  }
  const library = join(directory, 'lib', 'node_modules', 'logitping', 'dist', 'index');
  const esm = await import(`${library}.js`);
  const cjs = createRequire(import.meta.url)(`${library}.cjs`);
  assert.equal(esm.hellinger([1, 0], [0, 1]), 1);
  assert.equal(cjs.hellinger([1, 0], [0, 1]), 1);
  for (const { LogitpingError } of [esm, cjs]) assert.equal(new LogitpingError('HTTP_STATUS', 'test', { status: 401 }).status, 401);
  const consumerRequire = createRequire(join(directory, 'lib', 'consumer.cjs'));
  assert.equal(consumerRequire('logitping/package.json').name, 'logitping');
  assert.deepEqual(esm.validateBank(esm.defaultBank()), esm.defaultBank());
  const fixture = esm.defaultBank();
  fixture.calibration = null;
  for (const model of fixture.models) { model.status = 'uncalibrated'; model.profiles = []; }
  const fixturePath = join(directory, 'uncalibrated-bank.json');
  await writeFile(fixturePath, JSON.stringify(fixture));
  assert.ok((await stat(`${library}.d.ts`)).size > 0);
  assert.ok((await stat(`${library}.d.cts`)).size > 0);
  const consumer = `import { defaultBank, HttpClient, LogitpingError, type FingerprintBank, type LogitpingErrorCode } from 'logitping';
const bank: FingerprintBank = defaultBank();
const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.invalid', model: 'test' });
const code: LogitpingErrorCode | undefined = new LogitpingError('TRUNCATED', 'test').code;
void bank; void client; void code;
`;
  const consumers = ['consumer.mts', 'consumer.cts'].map((name) => join(directory, 'lib', name));
  for (const path of consumers) await writeFile(path, consumer);
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext',
    '--types', 'node', '--typeRoots', join(root, 'node_modules/@types'), ...consumers], { stdio: 'pipe' });
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request body */ }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '1 2 3 4 ' } }] })}\n\ndata: [DONE]\n\n`);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(join(directory, 'bin', 'lping'), ['--endpoint', `http://127.0.0.1:${port}`, '--model', 'test', '--bank', fixturePath, '--samples', '4', '--no-tokenizer', '--json'], { env: { ...process.env, LOGITPING_API_KEY: 'synthetic-test-secret' } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'UNCALIBRATED');
    assert.deepEqual(JSON.parse(result.stdout).samples, [1, 2, 3, 4]);
    assert.ok(!result.stdout.includes('synthetic-test-secret'));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  // A signal during a CLI-driver probe must still remove the temporary directory and report JSON,
  // although execa's cleanup handler (signal-exit) re-raises signals it believes nobody handles.
  const fakeBin = join(directory, 'fake-bin');
  const probeTmp = join(directory, 'probe-tmp');
  const started = join(directory, 'claude-started');
  await mkdir(fakeBin);
  await mkdir(probeTmp);
  await writeFile(join(fakeBin, 'claude'), '#!/bin/sh\n: > "$LOGITPING_SMOKE_STARTED"\nexec sleep 30\n', { mode: 0o755 });
  const interrupted = await new Promise((resolve, reject) => {
    const child = spawn(join(directory, 'bin', 'lping'), ['--driver', 'claude', '--json'], {
      env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}`, TMPDIR: probeTmp, LOGITPING_SMOKE_STARTED: started },
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const poll = setInterval(() => { if (existsSync(started)) { clearInterval(poll); child.kill('SIGTERM'); } }, 20);
    child.on('error', (error) => { clearInterval(poll); reject(error); });
    child.on('close', (status, signal) => { clearInterval(poll); resolve({ status, signal, stdout }); });
  });
  assert.deepEqual(interrupted, { status: 130, signal: null, stdout: `${JSON.stringify({ status: 'ERROR', error: 'Interrupted' })}\n` });
  assert.deepEqual(await readdir(probeTmp), []);
  const inputPath = join(directory, 'enrollment.json');
  const outputPath = join(directory, 'bank.json');
  const values = Array(64).fill(17);
  await writeFile(inputPath, JSON.stringify({
    source: 'SYNTHETIC packaging test',
    protocol: { id: 'integer-v1', language: 'en', targetSamples: 64, temperature: null, transport: 'openai' },
    checkpoints: [64],
    models: [{ id: 'test', family: 'synthetic', training: [values, values, values], validation: [values, values] }],
  }));
  const args = ['bank-create', '--input', inputPath, '--output', outputPath];
  execFileSync(join(directory, 'bin', 'lping'), args, { stdio: 'pipe' });
  const bank = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(bank.calibration.sequentialValidated, false);
  assert.equal(spawnSync(join(directory, 'bin', 'lping'), args).status, 1);
  console.log('Tarball install, both aliases, ESM/CJS exports, declarations, HTTP CLI, interrupt cleanup, and bank creation pass.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
