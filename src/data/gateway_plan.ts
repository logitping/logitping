import type { FingerprintBank, ModelFingerprint } from '../core/types.js';
import { errorCode, readBoundedText } from '../util/fs.js';
import { MAX_PAYLOAD_BYTES } from '../util/validate.js';
import { validateBank } from './bank_loader.js';
import type { GatewayBankConfig, GatewayProvider, GatewayTarget } from './gateway_config.js';

export interface BankUpdatePlan {
  /** Configured models to probe, in configuration order. */
  collect: GatewayTarget[];
  /** Enrolled models an incremental update keeps without new requests. */
  retain: string[];
  /** Retained models enrolled through a provider other than the configured one. */
  providerChanged: string[];
  /** Enrolled models probed again: uncalibrated, or enrolled under other settings. */
  replace: string[];
  /** Enrolled models no longer configured; an incremental update omits them. */
  remove: string[];
  /** Runs that must succeed. */
  requiredRuns: number;
  /** Attempts the request cap leaves for retries and resumes. */
  spareRequests: number;
  /** Upper bound on requested output tokens, including every spare attempt. */
  maxOutputTokens: number;
}

/** How provenance names each provider; a collected model's provenance begins with its label. */
export const PROVIDER_LABELS: Readonly<Record<GatewayProvider, string>> = {
  cloudflare: 'Cloudflare AI Gateway REST',
  openrouter: 'OpenRouter API',
};

const PROVIDERS = Object.keys(PROVIDER_LABELS) as GatewayProvider[];

/** Names `providers` in a fixed order, for bank-level sources and logs. */
export function providerLabel(providers: readonly (GatewayProvider | undefined)[]): string {
  return PROVIDERS.filter((provider) => providers.includes(provider)).map((provider) => PROVIDER_LABELS[provider]).join(' and ');
}

/** The provider an enrolled model was collected through, according to its provenance. */
export function enrolledProvider(model: ModelFingerprint): GatewayProvider | undefined {
  return PROVIDERS.find((provider) => model.provenance.startsWith(`${PROVIDER_LABELS[provider]}; `));
}

/** Recorded settings an enrolled model must match to be reused; only the token limit's value may differ. */
function reuseSettings(target: GatewayTarget): string {
  return `; model=${target.model}; api=${target.apiFormat}; stream=false; training=${target.trainingRuns}; validation=${target.validationRuns}; sampling=first-${target.sampleCount}; ${target.tokenLimitField}=`;
}

/** Collection settings as recorded in provenance. */
export function collectionSettings(target: GatewayTarget): string {
  return `${reuseSettings(target)}${target.maxTokens};`;
}

/**
 * Without `base`, collect every configured model. With it, collect only models the bank
 * does not already enroll under the configured protocol, checkpoints, and settings.
 */
export function planGatewayBankUpdate(config: GatewayBankConfig, base?: FingerprintBank): BankUpdatePlan {
  const enrolled = new Map(base?.models.map((model) => [model.id, model]));
  const protocol = (['id', 'language', 'targetSamples', 'temperature', 'transport'] as const)
    .every((key) => base?.protocol[key] === config.protocol[key]);
  const reusable = (target: GatewayTarget) => {
    const model = enrolled.get(target.id);
    return protocol && model?.status === 'calibrated' && model.family === target.family &&
      model.profiles.map((profile) => profile.sampleCount).join() === config.checkpoints.join() &&
      // Switching provider or token limit alone keeps a model: accepted runs were complete either way.
      model.provenance.includes(reuseSettings(target));
  };
  const collect = config.models.filter((target) => !reusable(target));
  const retained = config.models.filter(reusable);
  const configured = new Set(config.models.map((target) => target.id));
  const requiredRuns = collect.reduce((sum, target) => sum + target.trainingRuns + target.validationRuns, 0);
  // Manual resumes can retry an unfinished run after its automatic retries stop.
  // Include every spare request in the collection cap in this conservative bound.
  const spareRequests = collect.length ? config.maxRequests - requiredRuns : 0;
  return {
    collect,
    retain: retained.map((target) => target.id),
    providerChanged: retained.filter((target) => enrolledProvider(enrolled.get(target.id)!) !== target.provider).map((target) => target.id),
    replace: collect.filter((target) => enrolled.has(target.id)).map((target) => target.id),
    remove: [...enrolled.keys()].filter((id) => !configured.has(id)),
    requiredRuns, spareRequests,
    maxOutputTokens: collect.reduce((sum, target) => sum + (target.trainingRuns + target.validationRuns) * target.maxTokens, 0) +
      spareRequests * Math.max(0, ...collect.map((target) => target.maxTokens)),
  };
}

/** Validate the bank an incremental update merges into; `text` is its current content, if any. */
export function parseIncrementalBase(text: string | undefined): FingerprintBank {
  if (text === undefined) throw new Error('Incremental update needs an existing bank at the output path; run a full update to create one');
  if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) throw new Error('Existing bank exceeds the 16 MiB bank limit; run a full update to replace it');
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('Existing bank is not valid JSON; fix it or run a full update to replace it'); }
  try { return validateBank(value); }
  catch (error) { throw new Error(`${error instanceof Error ? error.message : 'Invalid bank'}; fix it or run a full update to replace it`); }
}

export async function readIncrementalBase(path: string): Promise<FingerprintBank> {
  let text: string | undefined;
  try { text = await readBoundedText(path, MAX_PAYLOAD_BYTES, 'Existing bank exceeds the 16 MiB bank limit; run a full update to replace it'); }
  catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  return parseIncrementalBase(text);
}
