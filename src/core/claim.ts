import { compareIds, type ClaimCounts, type ClaimPopulation } from '../data/claim_rates.js';
import type { AcceptanceRate, ClaimCheck, ClaimRates, FingerprintBank, ModelFingerprint, ProbeResult } from './types.js';

/**
 * The bank model a requested model identifier names: its last `/` segment, ignoring case, equals the
 * model's id, so `openai/gpt-6.1-sol` names `gpt-6.1-sol`. Ids that differ only by case resolve in bank order.
 */
export function claimedModel(bank: FingerprintBank, name: string): ModelFingerprint | undefined {
  const segment = name.split('/').at(-1)!.toLowerCase();
  return segment ? bank.models.find((model) => model.id.toLowerCase() === segment) : undefined;
}

/**
 * Whether the claimed model is among the result's candidates. `countsFor` returns a claimed model's
 * measured counts, when they apply to this bank and probe; it is called only for a checked claim.
 */
export function checkClaim(
  requested: string, bank: FingerprintBank, result: Pick<ProbeResult, 'status' | 'model' | 'candidates'>,
  countsFor?: (id: string) => ClaimCounts | undefined,
): ClaimCheck {
  const entry = claimedModel(bank, requested);
  const check = (verdict: ClaimCheck['verdict'], reason: string): ClaimCheck => {
    const counts = verdict === 'CONSISTENT' || verdict === 'INCONSISTENT' ? countsFor?.(entry!.id) : undefined;
    return { requested, model: entry?.id ?? null, verdict, reason, rates: counts ? deriveClaimRates(counts) : null };
  };
  if (!entry) return check('NOT_ENROLLED', `The bank enrolls no model named ${requested}.`);
  const { id } = entry;
  if (entry.status !== 'calibrated') return check('NOT_CHECKED', `${id} is enrolled without calibration, so it is never a candidate.`);
  const { candidates } = result;
  if (!candidates) return check('NOT_CHECKED', 'The probe computed no candidates, so the claim was not checked.');
  const identified = result.status === 'IDENTIFIED' ? result.model : null;
  if (candidates.includes(id)) {
    return check('CONSISTENT', identified === id ? `The probe identified ${id}.`
      : candidates.length === 1 ? `${id} is the only candidate.` : `${id} is among the ${candidates.length} candidates.`);
  }
  return check('INCONSISTENT', !candidates.length ? `${id} is not among the candidates; no enrolled model fits this probe.`
    : identified ? `The probe identified ${identified} instead.` : `${id} is not among the candidates: ${candidates.join(', ')}.`);
}

/** Two-sided 95% normal quantile. */
const Z = 1.959963984540054;

/** Bounds of the 95% Wilson score interval of accepted / runs; the whole range without runs. */
export function wilsonInterval(accepted: number, runs: number): { low: number; high: number } {
  if (!runs) return { low: 0, high: 1 };
  const p = accepted / runs;
  const z2 = Z * Z;
  const denominator = 1 + z2 / runs;
  const center = (p + z2 / (2 * runs)) / denominator;
  const half = (Z * Math.sqrt(p * (1 - p) / runs + z2 / (4 * runs * runs))) / denominator;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** Other models whose runs pass as a claim at least this often are listed in `mostAccepted`. */
export const MOST_ACCEPTED_RATE = 0.5;

const rate = (accepted: number, runs: number): AcceptanceRate => ({ accepted, runs, ...wilsonInterval(accepted, runs) });

/** A claim's rates from its raw counts; the report and the engine both use this. */
export function deriveClaimRates(counts: ClaimCounts): ClaimRates {
  const pool = (populations: readonly ClaimPopulation[]) => {
    const rows = counts.runs.filter((row) => populations.includes(row.population));
    return rate(rows.reduce((sum, row) => sum + row.accepted, 0), rows.reduce((sum, row) => sum + row.runs, 0));
  };
  const mostAccepted = counts.runs
    .filter((row) => row.population !== 'removed' && row.accepted >= MOST_ACCEPTED_RATE * row.runs)
    .sort((a, b) => b.accepted / b.runs - a.accepted / a.runs || b.runs - a.runs || compareIds(a.model, b.model))
    .map((row) => ({ model: row.model, enrolled: row.population === 'enrolled', accepted: row.accepted, runs: row.runs }));
  return {
    own: { source: counts.own.source, ...rate(counts.own.accepted, counts.own.runs) },
    enrolled: pool(['enrolled']), outside: pool(['removed', 'unenrolled']), mostAccepted,
  };
}
