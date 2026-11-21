import type { ClaimCheck, FingerprintBank, ModelFingerprint, ProbeResult } from './types.js';

/**
 * The bank model a requested model identifier names: its last `/` segment, ignoring case, equals the
 * model's id, so `openai/gpt-6.1-sol` names `gpt-6.1-sol`. Ids that differ only by case resolve in bank order.
 */
export function claimedModel(bank: FingerprintBank, name: string): ModelFingerprint | undefined {
  const segment = name.split('/').at(-1)!.toLowerCase();
  return segment ? bank.models.find((model) => model.id.toLowerCase() === segment) : undefined;
}

/** Whether the claimed model is among the result's candidates; see the spec's verdict table. */
export function checkClaim(requested: string, bank: FingerprintBank, result: Pick<ProbeResult, 'status' | 'model' | 'candidates'>): ClaimCheck {
  const entry = claimedModel(bank, requested);
  const check = (verdict: ClaimCheck['verdict'], reason: string): ClaimCheck => ({ requested, model: entry?.id ?? null, verdict, reason, rates: null });
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
