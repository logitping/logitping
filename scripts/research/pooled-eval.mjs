// Evaluate pooled scoring on stored runs with the production engine. Makes no provider requests.
// Usage: npm run build && node scripts/research/pooled-eval.mjs <corpus.json>... [--bank <bank.json>]
//
// Several corpora are combined in the order given; the first one holding a model supplies its runs.
// Without --bank (leave-group-out): each group of 8 runs is probed against a bank fitted without those
// runs (enrolled), and against a bank fitted without that model (unenrolled).
// With --bank (separate collection): each group is probed against that fixed bank. Models the bank does
// not enroll, or fitted from these runs, are skipped, so no run is scored against a bank it helped fit.
//
// Grouping 0 assigns run i to group i % G, as in the published table. Groupings 1-9 are seeded random
// partitions of the same runs, so they show where errors concentrate but add no new data.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { corpusDigest } from '../../build/maintainer.js';
import { createPooledBank, fingerprint } from '../../dist/index.js';

const K = 8;
const GROUPINGS = 10;

const { positionals: corpusPaths, values: { bank: bankPath } } = parseArgs({ allowPositionals: true, options: { bank: { type: 'string' } } });
if (!corpusPaths.length) throw new Error('Usage: pooled-eval.mjs <corpus.json>... [--bank <bank.json>]');
const corpora = corpusPaths.map((path) => JSON.parse(readFileSync(path, 'utf8')));
const [{ protocol, checkpoints }] = corpora;
const settings = (corpus) => JSON.stringify([corpus.protocol, corpus.checkpoints]);
if (corpora.some((corpus) => settings(corpus) !== settings(corpora[0]))) throw new Error('These corpora were collected under different protocols');
const digests = corpora.map(corpusDigest);
const allModels = [];
const digestOf = new Map();
corpora.forEach((corpus, index) => {
  for (const model of corpus.models) {
    if (digestOf.has(model.id)) continue;
    digestOf.set(model.id, digests[index]);
    allModels.push(model);
  }
});
const fixed = bankPath ? JSON.parse(readFileSync(bankPath, 'utf8')) : undefined;

const runsOf = (model) => [...model.training, ...model.validation];
const enroll = (models) => createPooledBank({ source: 'evaluation', protocol, checkpoints, requestsPerProbe: K, models });

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function partition(n, groups, grouping) {
  const order = Array.from({ length: n }, (_, i) => i);
  if (grouping) {
    const random = mulberry32(20261107 + grouping);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  return Array.from({ length: groups }, (_, group) => order.filter((_, position) => position % groups === group));
}

/** The prediction set the production engine returns for these replies. */
async function probe(bank, responses) {
  let index = 0;
  const transport = { name: 'openai', granularity: 'token', async *stream() { yield `${responses[index++].join(' ')} `; } };
  return (await fingerprint(transport, { bank, earlyStopping: false })).candidates ?? [];
}

const emptyTally = () => ({ probes: 0, correct: 0, wrong: {}, sets: 0, empty: 0 });
function record(tally, set, id) {
  tally.probes++;
  if (set.length > 1) tally.sets++;
  else if (!set.length) tally.empty++;
  else if (set[0] === id) tally.correct++;
  else tally.wrong[set[0]] = (tally.wrong[set[0]] ?? 0) + 1;
}

const included = allModels.filter((model) => {
  if (!fixed) return true;
  const enrolled = fixed.models.find((candidate) => candidate.id === model.id);
  return enrolled && !enrolled.provenance.includes(`corpus sha256:${digestOf.get(model.id)};`);
});
const models = Object.fromEntries(included.map((model) => [model.id, {
  firstGrouping: { enrolled: emptyTally(), unenrolled: emptyTally() },
  allGroupings: { enrolled: emptyTally(), unenrolled: emptyTally() },
}]));

for (const model of included) {
  const runs = runsOf(model);
  const withoutModel = fixed ? undefined : enroll(allModels.filter((other) => other !== model));
  const tallies = models[model.id];
  for (let grouping = 0; grouping < GROUPINGS; grouping++) {
    for (const held of partition(runs.length, Math.round(runs.length / K), grouping)) {
      const heldOut = new Set(held);
      const responses = held.map((i) => runs[i]);
      const bank = fixed ?? enroll(allModels.map((other) => other !== model ? other : {
        ...other,
        training: other.training.filter((_, i) => !heldOut.has(i)),
        validation: other.validation.filter((_, i) => !heldOut.has(i + other.training.length)),
      }));
      const set = await probe(bank, responses);
      record(tallies.allGroupings.enrolled, set, model.id);
      if (!grouping) record(tallies.firstGrouping.enrolled, set, model.id);
      if (withoutModel) {
        // No answer can be right here, so any single model counts under `wrong`.
        const outside = await probe(withoutModel, responses);
        record(tallies.allGroupings.unenrolled, outside, model.id);
        if (!grouping) record(tallies.firstGrouping.unenrolled, outside, model.id);
      }
    }
  }
}

function total(scope, side) {
  const sum = emptyTally();
  for (const tally of Object.values(models).map((entry) => entry[scope][side])) {
    sum.probes += tally.probes; sum.correct += tally.correct; sum.sets += tally.sets; sum.empty += tally.empty;
    for (const [id, count] of Object.entries(tally.wrong)) sum.wrong[id] = (sum.wrong[id] ?? 0) + count;
  }
  return sum;
}
const summary = (scope) => ({ enrolled: total(scope, 'enrolled'), unenrolled: fixed ? undefined : total(scope, 'unenrolled') });

console.log(JSON.stringify({
  mode: fixed ? 'separate collection' : 'leave-group-out',
  corpora: digests,
  skipped: allModels.filter((model) => !included.includes(model)).map((model) => model.id),
  firstGrouping: summary('firstGrouping'),
  allGroupings: summary('allGroupings'),
  models,
}, null, 1));
