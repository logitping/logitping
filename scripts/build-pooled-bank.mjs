// Add pooled-sets-v1 scoring to a bank the updater collected, from its archived corpus, without new requests.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { attachPooledScoring, loadBank } from '../build/maintainer.js';

const command = new Command()
  .name('build-pooled-bank')
  .requiredOption('--bank <path>', 'bank written by the updater (schema version 1)')
  .requiredOption('--corpus <path>', 'the corpus archived with that bank')
  .requiredOption('--output <path>', 'new pooled bank path; an existing file is never overwritten')
  .option('--requests <count>', 'requests per probe', '8');
command.parse();
const options = command.opts();
const bank = await loadBank(options.bank);
const { protocol, checkpoints, models } = JSON.parse(await readFile(options.corpus, 'utf8'));
// The updater records this digest in every collected model's provenance.
const digest = createHash('sha256').update(JSON.stringify({ protocol, checkpoints, models })).digest('hex');
for (const model of bank.models) {
  if (!model.provenance.includes(`corpus sha256:${digest};`)) throw new Error(`${model.id} was not fitted from this corpus (sha256:${digest})`);
}
const pooled = attachPooledScoring(bank, models, { requestsPerProbe: Number(options.requests) });
await writeFile(options.output, `${JSON.stringify(pooled, null, 2)}\n`, { flag: 'wx' });
console.log(`Wrote ${options.output}: ${pooled.models.length} models, ${pooled.protocol.requestsPerProbe} requests × ${pooled.protocol.targetSamples} integers, corpus sha256:${digest}.`);
