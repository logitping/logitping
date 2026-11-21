import { createHash } from 'node:crypto';
import { fingerprint } from '../core/engine.js';
import type { FingerprintBank, ProbeTransport } from '../core/types.js';
import { INTEGER_MAX, INTEGER_MIN } from '../math/ordered_block.js';
import { mulberry32 } from '../math/pooled_sets.js';
import { isIntegerInRange, isRecord } from '../util/validate.js';
import { validateBank } from './bank_loader.js';
import { corpusDigest, sameProtocol } from './gateway_plan.js';

/** The fields of a corpus the bank updater archives; its digest names it in model provenance. */
export interface StoredCorpus {
  collectedAt: string;
  protocol: FingerprintBank['protocol'];
  checkpoints: number[];
  models: { id: string; training: number[][]; validation: number[][] }[];
}

export interface DigestedCorpus { digest: string; corpus: StoredCorpus }

/**
 * Single-request probes of one model: `wrong` maps the model named instead to a count. Of the
 * candidate lists, `listed` counts those naming the tested model, `empty` those with no model,
 * `candidateCount` sums their lengths, and `multiVendor` counts those spanning several families.
 */
export interface StatusTally {
  runs: number; correct: number; wrong: Record<string, number>; inconclusive: number; unknown: number;
  listed: number; empty: number; candidateCount: number; multiVendor: number;
}

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
const emptyStatus = (): StatusTally => ({ runs: 0, correct: 0, wrong: {}, inconclusive: 0, unknown: 0, listed: 0, empty: 0, candidateCount: 0, multiVendor: 0 });

async function scoreRuns(bank: FingerprintBank, model: CorpusModels[number]): Promise<StatusTally> {
  const tally = emptyStatus();
  // Families come from the bank that scored the run; a removed tested model has none.
  const family = new Map(bank.models.map((entry) => [entry.id, entry.family]));
  for (const run of runsOf(model)) {
    const { status, model: named, candidates = [] } = await fingerprint(replay([run]), { bank, earlyStopping: false });
    tally.runs++;
    if (status === 'IDENTIFIED' && named === model.id) tally.correct++;
    else if (status === 'IDENTIFIED' && named) tally.wrong[named] = (tally.wrong[named] ?? 0) + 1;
    else if (status === 'INCONCLUSIVE') tally.inconclusive++;
    else if (status === 'UNKNOWN_MODEL') tally.unknown++;
    else throw new Error(`Unexpected ${status} for ${model.id}`);
    if (candidates.includes(model.id)) tally.listed++;
    if (!candidates.length) tally.empty++;
    tally.candidateCount += candidates.length;
    if (new Set(candidates.map((id) => family.get(id))).size > 1) tally.multiVendor++;
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
export interface SetTally { probes: number; correct: number; wrong: Record<string, number>; several: number; none: number; stopped: number; listed: number }

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

const emptySets = (): SetTally => ({ probes: 0, correct: 0, wrong: {}, several: 0, none: 0, stopped: 0, listed: 0 });

async function scoreGroups(bank: FingerprintBank, model: CorpusModels[number], size: number, groupings: number): Promise<SetTally> {
  const runs = runsOf(model);
  const tally = emptySets();
  for (let grouping = 0; grouping < groupings; grouping++) {
    for (const group of groupRuns(runs.length, size, grouping)) {
      const { candidates } = await fingerprint(replay(group.map((index) => runs[index]!)), { bank, earlyStopping: false });
      tally.probes++;
      if (candidates?.includes(model.id)) tally.listed++;
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

export interface BankSummary { file: string; sha256: string; models: number }
export interface CorpusSummary { sha256: string; collectedAt: string; targetSamples: number; models: string[] }

/** The committed independent evaluation of both bundled banks (docs/evaluation.json). */
export interface EvaluationReport {
  schemaVersion: 2;
  banks: { default: BankSummary; pooled: BankSummary };
  /** Sorted by collectedAt, then sha256. */
  corpora: CorpusSummary[];
  default: DefaultResults;
  pooled: PooledResults;
}

export interface EvaluationInput {
  default: { file: string; text: string };
  pooled: { file: string; text: string };
  /** Parsed corpus files, in any order; a corpus read twice counts once. */
  corpora: readonly unknown[];
}

/** Lowercase hex SHA-256 of UTF-8 text; ties a report to the exact bank files it scored. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Score both bundled banks on every stored run they were not built from. */
export async function evaluateBanks(input: EvaluationInput): Promise<EvaluationReport> {
  const defaultBank = validateBank(JSON.parse(input.default.text));
  const pooledBank = validateBank(JSON.parse(input.pooled.text));
  if (pooledBank.schemaVersion !== 2) throw new Error('Pooled evaluation needs a pooled bank (schema version 2)');
  if (!input.corpora.length) throw new Error('No stored corpora (*.corpus-*.json) were found; the report needs the maintainer corpora');
  const seen = new Set<string>();
  const corpora: DigestedCorpus[] = [];
  for (const value of input.corpora) {
    const parsed = parseStoredCorpus(value);
    if (seen.has(parsed.digest)) continue;
    seen.add(parsed.digest);
    if (!sameProtocol(defaultBank, parsed.corpus) && !sameProtocol(pooledBank, parsed.corpus)) {
      throw new Error(`Corpus sha256:${parsed.digest} matches neither bank's protocol`);
    }
    corpora.push(parsed);
  }
  corpora.sort((a, b) => a.corpus.collectedAt.localeCompare(b.corpus.collectedAt) || a.digest.localeCompare(b.digest));
  const summary = (file: string, text: string, bank: FingerprintBank): BankSummary => ({ file, sha256: sha256(text), models: bank.models.length });
  return {
    schemaVersion: 2,
    banks: { default: summary(input.default.file, input.default.text, defaultBank), pooled: summary(input.pooled.file, input.pooled.text, pooledBank) },
    corpora: corpora.map(({ digest, corpus }) => ({ sha256: digest, collectedAt: corpus.collectedAt, targetSamples: corpus.protocol.targetSamples, models: corpus.models.map((model) => model.id) })),
    default: await evaluateDefaultBank(defaultBank, corpora.filter(({ corpus }) => sameProtocol(defaultBank, corpus))),
    pooled: await evaluatePooledBank(pooledBank, corpora.filter(({ corpus }) => sameProtocol(pooledBank, corpus))),
  };
}

/** `0`, or the total and each named model, by count descending, then id. */
function named(wrong: Record<string, number>): string {
  const entries = Object.entries(wrong).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return total ? `${total} (${entries.map(([id, count]) => `${id} ${count}`).join(', ')})` : '0';
}

const shortDigest = (digest: string) => `\`${digest.slice(0, 12)}\``;
const row = (cells: readonly (string | number)[]) => `| ${cells.join(' | ')} |`;

/** A section's table with a total row, or `No runs.` when it has none. */
function table<T extends object>(header: readonly string[], entries: readonly CorpusTallies<T>[], cells: (tally: T) => (string | number)[], sum: (tallies: T[]) => T): string {
  const rows = entries.flatMap(({ corpus, models }) => Object.entries(models).map(([id, tally]) => row([shortDigest(corpus), id, ...cells(tally as T)])));
  if (!rows.length) return 'No runs.';
  const total = sum(entries.flatMap(({ models }) => Object.values(models) as T[]));
  return [row(header), row(header.map(() => '---')), ...rows, `| **Total** | ${row(cells(total))}`].join('\n');
}

const mergeWrong = (tallies: { wrong: Record<string, number> }[]) => {
  const wrong: Record<string, number> = {};
  for (const tally of tallies) for (const [id, count] of Object.entries(tally.wrong)) wrong[id] = (wrong[id] ?? 0) + count;
  return wrong;
};
const total = <T>(tallies: T[], field: { [K in keyof T]: T[K] extends number ? K : never }[keyof T]) =>
  tallies.reduce((sum, tally) => sum + (tally[field] as number), 0);
const sumStatus = (tallies: StatusTally[]): StatusTally => ({
  runs: total(tallies, 'runs'), correct: total(tallies, 'correct'), wrong: mergeWrong(tallies),
  inconclusive: total(tallies, 'inconclusive'), unknown: total(tallies, 'unknown'), listed: total(tallies, 'listed'),
  empty: total(tallies, 'empty'), candidateCount: total(tallies, 'candidateCount'), multiVendor: total(tallies, 'multiVendor'),
});
const sumSets = (tallies: SetTally[]): SetTally => ({
  probes: total(tallies, 'probes'), correct: total(tallies, 'correct'), wrong: mergeWrong(tallies),
  several: total(tallies, 'several'), none: total(tallies, 'none'), stopped: total(tallies, 'stopped'), listed: total(tallies, 'listed'),
});
/** Mean candidate-list length, one decimal. */
const meanCandidates = (tally: StatusTally) => (tally.candidateCount / tally.runs).toFixed(1);

/** docs/evaluation.md, derived only from the report so the test can compare it with the committed file. */
export function renderEvaluationReport(report: EvaluationReport): string {
  const section = (heading: string, body: string) => `${heading}\n\n${body}`;
  const status = ['Corpus', 'Model', 'Runs'];
  const sets = ['Corpus', 'Model', 'Probes'];
  const { default: defaults, pooled } = report;
  const parts = [
    '# Independent evaluation',
    '<!-- Generated by `npm run bank:evaluate` from evaluation.json. Do not edit; rerun the command. -->',
    '[Back to README](../README.md) · [Bank status](bank.md#evaluation-status) · [Bank maintenance](bank-maintenance.md#evaluate-the-bundled-banks)',
    'Each bundled bank is scored on every stored run it was not built from, with the production engine and no provider requests. Corpora are named by the first 12 characters of their SHA-256. Candidates are the enrolled models the engine cannot rule out; "Listed" counts runs or probes whose candidates include the tested model, and "Several vendors" those whose candidates span more than one model family.',
    [row(['Bank', 'File', 'SHA-256', 'Models']), row(['---', '---', '---', '---']),
      ...([['Default', report.banks.default], ['Pooled', report.banks.pooled]] as const).map(([name, bank]) => row([name, `\`${bank.file}\``, `\`${bank.sha256}\``, bank.models]))].join('\n'),
    section('## Corpora', [row(['Corpus', 'Collected', 'Integers per run', 'Models']), row(['---', '---', '---', '---']),
      ...report.corpora.map((corpus) => row([shortDigest(corpus.sha256), corpus.collectedAt.slice(0, 10), corpus.targetSamples, corpus.models.join(', ')]))].join('\n')),
    '## Default bank',
    section('### Enrolled models, runs from other collections', table([...status, 'Correct', 'Wrong', 'INCONCLUSIVE', 'UNKNOWN_MODEL', 'Listed', 'Mean candidates', 'Several vendors'], defaults.enrolled,
      (t: StatusTally) => [t.runs, t.correct, named(t.wrong), t.inconclusive, t.unknown, t.listed, meanCandidates(t), t.multiVendor], sumStatus)),
    section('### Same runs, tested model removed', table([...status, 'Named', 'INCONCLUSIVE', 'UNKNOWN_MODEL', 'No candidate', 'Mean candidates', 'Several vendors'], defaults.labelRemoved,
      (t: StatusTally) => [t.runs, named(t.wrong), t.inconclusive, t.unknown, t.empty, meanCandidates(t), t.multiVendor], sumStatus)),
    section('### Models the bank does not enroll', table([...status, 'Named', 'INCONCLUSIVE', 'UNKNOWN_MODEL', 'No candidate', 'Mean candidates', 'Several vendors'], defaults.neverEnrolled,
      (t: StatusTally) => [t.runs, named(t.wrong), t.inconclusive, t.unknown, t.empty, meanCandidates(t), t.multiVendor], sumStatus)),
    `## Pooled bank: ${pooled.requestsPerProbe} requests per probe, ${pooled.groupings} groupings`,
    section('### Enrolled models, runs from other collections', table([...sets, 'Correct', 'Wrong', 'Several', 'None', 'Stopped', 'Listed'], pooled.enrolled,
      (t: SetTally) => [t.probes, t.correct, named(t.wrong), t.several, t.none, t.stopped, t.listed], sumSets)),
    section('### Models the bank does not enroll', table([...sets, 'Named', 'Several', 'None', 'Stopped'], pooled.neverEnrolled,
      (t: SetTally) => [t.probes, named(t.wrong), t.several, t.none, t.stopped], sumSets)),
  ];
  return `${parts.join('\n\n')}\n`;
}
