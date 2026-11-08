// Add pooled-sets-v1 scoring to banks the updater collected, from their archived corpora, without new requests.
import { readFile, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { attachPooledScoring, corpusDigest, loadBank, loadGatewayBankConfig, refitPooledBank } from '../build/maintainer.js';

// This script contacts no provider, so a configuration needs no real credentials here.
const NO_CREDENTIALS = {
  CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32), CLOUDFLARE_GATEWAY_ID: 'unused', CLOUDFLARE_API_TOKEN: 'unused',
  OPENROUTER_API_KEY: 'unused', GEMINI_API_KEY: 'unused', OPENAI_API_KEY: 'unused',
};
const repeated = (value, previous) => [...previous, value];

const command = new Command()
  .name('build-pooled-bank')
  .allowExcessArguments(false)
  .option('--bank <path>', 'bank written by the updater (schema version 1); repeat for each collection', repeated, [])
  .option('--corpus <path>', 'the corpus archived with that bank; repeat in the same order', repeated, [])
  .option('--config <path>', "pooled configuration that sets each model's route and the requests per probe; required for more than one collection")
  .requiredOption('--output <path>', 'new pooled bank path; an existing file is never overwritten')
  .option('--requests <count>', 'requests per probe without --config (default 8)');

try {
  command.parse();
  const options = command.opts();
  if (!options.bank.length || options.bank.length !== options.corpus.length) throw new Error('Give one --corpus for each --bank');
  if (options.config && options.requests) throw new Error('--config sets the requests per probe; remove --requests');
  if (!options.config && options.bank.length > 1) throw new Error("Combining collections needs --config to choose each model's collection");
  const collections = await Promise.all(options.bank.map(async (path, index) => ({
    bank: await loadBank(path),
    corpus: JSON.parse(await readFile(options.corpus[index], 'utf8')),
  })));
  let pooled;
  if (options.config) {
    pooled = refitPooledBank(await loadGatewayBankConfig(options.config, NO_CREDENTIALS), collections);
  } else {
    const [{ bank, corpus }] = collections;
    // The updater records this digest in every collected model's provenance.
    const digest = corpusDigest(corpus);
    for (const model of bank.models) {
      if (!model.provenance.includes(`corpus sha256:${digest};`)) throw new Error(`${model.id} was not fitted from this corpus (sha256:${digest})`);
    }
    pooled = attachPooledScoring(bank, corpus.models, { requestsPerProbe: Number(options.requests ?? 8) });
  }
  await writeFile(options.output, `${JSON.stringify(pooled, null, 2)}\n`, { flag: 'wx' });
  console.log(`Wrote ${options.output}: ${pooled.models.length} models, ${pooled.protocol.requestsPerProbe} requests × ${pooled.protocol.targetSamples} integers.`);
  const sources = Map.groupBy(pooled.models, (model) => /corpus sha256:([0-9a-f]{64});/.exec(model.provenance)?.[1] ?? 'unrecorded');
  for (const [digest, models] of sources) console.log(`  corpus sha256:${digest}: ${models.map((model) => model.id).join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Pooled bank build failed');
  process.exitCode = 1;
}
