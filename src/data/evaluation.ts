import { fingerprint } from '../core/engine.js';
import type { FingerprintBank, ProbeTransport } from '../core/types.js';
import { INTEGER_MAX, INTEGER_MIN } from '../math/ordered_block.js';
import { mulberry32 } from '../math/pooled_sets.js';
import { isIntegerInRange, isRecord } from '../util/validate.js';
import { corpusDigest } from './gateway_plan.js';

/** The fields of a corpus the bank updater archives; its digest names it in model provenance. */
export interface StoredCorpus {
  collectedAt: string;
  protocol: FingerprintBank['protocol'];
  checkpoints: number[];
  models: { id: string; training: number[][]; validation: number[][] }[];
}

export interface DigestedCorpus { digest: string; corpus: StoredCorpus }

/** Single-request probes of one model: `wrong` maps the model named instead to a count. */
export interface StatusTally { runs: number; correct: number; wrong: Record<string, number>; inconclusive: number; unknown: number }

/** Per-model tallies of the runs one corpus contributed; `corpus` is its SHA-256. */
export interface CorpusTallies<T> { corpus: string; models: Record<string, T> }

export interface DefaultResults {
  enrolled: CorpusTallies<StatusTally>[];
  labelRemoved: CorpusTallies<StatusTally>[];
  neverEnrolled: CorpusTallies<StatusTally>[];
}

type CorpusModels = StoredCorpus['models'];

const notCorpus = () => new Error('Input is not a stored corpus');

/** Validate a parsed corpus file and name it by the digest model provenance records. */
export function parseStoredCorpus(value: unknown): DigestedCorpus {
  if (!isRecord(value) || typeof value.collectedAt !== 'string' || !isRecord(value.protocol) ||
      !Number.isSafeInteger(value.protocol.targetSamples) || !Array.isArray(value.checkpoints) || !Array.isArray(value.models)) {
    throw notCorpus();
  }
  const targetSamples = value.protocol.targetSamples as number;
  for (const entry of value.models as unknown[]) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !Array.isArray(entry.training) || !Array.isArray(entry.validation)) throw notCorpus();
    const valid = [...entry.training, ...entry.validation].every((run: unknown) => Array.isArray(run) && run.length === targetSamples &&
      run.every((sample) => isIntegerInRange(sample, INTEGER_MIN, INTEGER_MAX)));
    if (!valid) throw new Error(`Corpus model ${entry.id}: every run must have ${targetSamples} integers in [${INTEGER_MIN}, ${INTEGER_MAX}]`);
  }
  const corpus = {
    collectedAt: value.collectedAt, protocol: value.protocol, checkpoints: value.checkpoints, models: value.models,
  } as StoredCorpus;
  return { digest: corpusDigest(corpus), corpus };
}

/** A corpus's runs that `bank` was not fitted from: of enrolled models, and of models it does not enroll. */
export function corpusRoles(bank: FingerprintBank, { digest, corpus }: DigestedCorpus): { independent: CorpusModels; neverEnrolled: CorpusModels } {
  const independent: CorpusModels = [];
  const neverEnrolled: CorpusModels = [];
  for (const model of corpus.models) {
    const enrolled = bank.models.find((candidate) => candidate.id === model.id);
    if (!enrolled) neverEnrolled.push(model);
    else if (!enrolled.provenance.includes(`corpus sha256:${digest};`)) independent.push(model);
  }
  return { independent, neverEnrolled };
}

/** A transport answering request i with responses[i], as the stored reply would have streamed. */
function replay(responses: readonly (readonly number[])[]): ProbeTransport {
  let request = 0;
  return {
    name: 'openai', granularity: 'token',
    async *stream() { yield `${responses[request++]!.join(' ')} `; },
  };
}

const runsOf = (model: CorpusModels[number]) => [...model.training, ...model.validation];
const emptyStatus = (): StatusTally => ({ runs: 0, correct: 0, wrong: {}, inconclusive: 0, unknown: 0 });

async function scoreRuns(bank: FingerprintBank, model: CorpusModels[number]): Promise<StatusTally> {
  const tally = emptyStatus();
  for (const run of runsOf(model)) {
    const { status, model: named } = await fingerprint(replay([run]), { bank, earlyStopping: false });
    tally.runs++;
    if (status === 'IDENTIFIED' && named === model.id) tally.correct++;
    else if (status === 'IDENTIFIED' && named) tally.wrong[named] = (tally.wrong[named] ?? 0) + 1;
    else if (status === 'INCONCLUSIVE') tally.inconclusive++;
    else if (status === 'UNKNOWN_MODEL') tally.unknown++;
    else throw new Error(`Unexpected ${status} for ${model.id}`);
  }
  return tally;
}

/** One probe per stored run that `bank` was not fitted from, with the production engine. */
export async function evaluateDefaultBank(bank: FingerprintBank, corpora: readonly DigestedCorpus[]): Promise<DefaultResults> {
  const results: DefaultResults = { enrolled: [], labelRemoved: [], neverEnrolled: [] };
  const withoutModel = new Map<string, FingerprintBank>();
  const add = async (list: CorpusTallies<StatusTally>[], corpus: string, models: CorpusModels, bankFor: (id: string) => FingerprintBank) => {
    if (!models.length) return;
    const entry: CorpusTallies<StatusTally> = { corpus, models: {} };
    for (const model of models) entry.models[model.id] = await scoreRuns(bankFor(model.id), model);
    list.push(entry);
  };
  const removed = (id: string) => {
    if (!withoutModel.has(id)) withoutModel.set(id, { ...bank, models: bank.models.filter((model) => model.id !== id) });
    return withoutModel.get(id)!;
  };
  for (const corpus of corpora) {
    const { independent, neverEnrolled } = corpusRoles(bank, corpus);
    await add(results.enrolled, corpus.digest, independent, () => bank);
    await add(results.labelRemoved, corpus.digest, independent, removed);
    await add(results.neverEnrolled, corpus.digest, neverEnrolled, () => bank);
  }
  return results;
}

/** Pooled probes of one model: `several` and `none` are prediction sets; `stopped` probes ended on a repeated reply. */
export interface SetTally { probes: number; correct: number; wrong: Record<string, number>; several: number; none: number; stopped: number }

export interface PooledResults {
  groupings: number;
  requestsPerProbe: number;
  enrolled: CorpusTallies<SetTally>[];
  neverEnrolled: CorpusTallies<SetTally>[];
}

/** Groupings of each model's runs, as in scripts/research/pooled-eval.mjs. */
export const EVALUATION_GROUPINGS = 10;
/** Shuffle seed of grouping g is GROUPING_SEED + g; grouping 0 keeps the stored order. */
export const GROUPING_SEED = 20261107;

/**
 * floor(count / size) groups of `size` run indices. Grouping 0 assigns position p to group
 * p mod groups; later groupings first shuffle with a seeded generator. Equals pooled-eval.mjs's
 * partition whenever count is a multiple of size.
 */
export function groupRuns(count: number, size: number, grouping: number): number[][] {
  const groups = Math.floor(count / size);
  if (!groups) return [];
  const order = Array.from({ length: count }, (_, i) => i);
  if (grouping) {
    const random = mulberry32(GROUPING_SEED + grouping);
    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
  }
  return Array.from({ length: groups }, (_, group) => order.filter((_, position) => position % groups === group).slice(0, size));
}

const emptySets = (): SetTally => ({ probes: 0, correct: 0, wrong: {}, several: 0, none: 0, stopped: 0 });

async function scoreGroups(bank: FingerprintBank, model: CorpusModels[number], size: number, groupings: number): Promise<SetTally> {
  const runs = runsOf(model);
  const tally = emptySets();
  for (let grouping = 0; grouping < groupings; grouping++) {
    for (const group of groupRuns(runs.length, size, grouping)) {
      const { candidates } = await fingerprint(replay(group.map((index) => runs[index]!)), { bank, earlyStopping: false });
      tally.probes++;
      if (candidates === undefined) tally.stopped++;
      else if (candidates.length > 1) tally.several++;
      else if (!candidates.length) tally.none++;
      else if (candidates[0] === model.id) tally.correct++;
      else tally.wrong[candidates[0]!] = (tally.wrong[candidates[0]!] ?? 0) + 1;
    }
  }
  return tally;
}

/** Pooled probes, each of one model's runs from one corpus, against the fixed pooled bank. */
export async function evaluatePooledBank(bank: FingerprintBank, corpora: readonly DigestedCorpus[], groupings = EVALUATION_GROUPINGS): Promise<PooledResults> {
  if (bank.schemaVersion !== 2 || bank.protocol.requestsPerProbe === undefined) throw new Error('Pooled evaluation needs a pooled bank (schema version 2)');
  const size = bank.protocol.requestsPerProbe;
  const results: PooledResults = { groupings, requestsPerProbe: size, enrolled: [], neverEnrolled: [] };
  const add = async (list: CorpusTallies<SetTally>[], corpus: string, models: CorpusModels) => {
    const entry: CorpusTallies<SetTally> = { corpus, models: {} };
    for (const model of models) {
      const tally = await scoreGroups(bank, model, size, groupings);
      if (tally.probes) entry.models[model.id] = tally;
    }
    if (Object.keys(entry.models).length) list.push(entry);
  };
  for (const corpus of corpora) {
    const { independent, neverEnrolled } = corpusRoles(bank, corpus);
    await add(results.enrolled, corpus.digest, independent);
    await add(results.neverEnrolled, corpus.digest, neverEnrolled);
  }
  return results;
}
