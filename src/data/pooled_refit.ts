import type { FingerprintBank } from '../core/types.js';
import { validateBank } from './bank_loader.js';
import type { GatewayBankConfig } from './gateway_config.js';
import { corpusDigest, enrolledAs, enrolledProvider, providerLabel, sameProtocol } from './gateway_plan.js';
import { attachPooledScoring, type EnrolledRuns } from './pooled_enrollment.js';

/** A bank the updater wrote without pooled scoring, and the corpus archived with it. */
export interface PooledCollection {
  bank: FingerprintBank;
  corpus: { protocol: unknown; checkpoints: unknown; models: EnrolledRuns };
}

const fitSettings = ({ featureVersion, alpha, nuisanceDirections }: FingerprintBank) => JSON.stringify({ featureVersion, alpha, nuisanceDirections });

/**
 * Fit `config`'s pooled bank from earlier collections, without new requests. Each model comes from
 * the one collection whose provenance records its configured route and settings, so a superseded
 * route can never be picked up by accident. Envelopes depend only on a model's own runs and are kept
 * as collected; pooled cutoffs and pair statistics depend on every model's runs and are fitted anew.
 */
export function refitPooledBank(config: GatewayBankConfig, collections: readonly PooledCollection[]): FingerprintBank {
  const { requestsPerProbe } = config;
  if (requestsPerProbe === undefined) throw new Error('Pooled refit needs a configuration with pooled scoring');
  for (const { bank } of collections) {
    if (bank.schemaVersion !== 1) throw new Error('Pooled refit needs banks of schema version 1, which the updater writes without pooled scoring');
    if (!sameProtocol(bank, config)) throw new Error('A collection\'s protocol differs from the configuration');
    if (fitSettings(bank) !== fitSettings(collections[0]!.bank)) throw new Error('Collections were fitted with different settings');
  }
  const selected = config.models.map((target) => {
    const sources = collections.flatMap((collection) => {
      const model = collection.bank.models.find((candidate) => candidate.id === target.id);
      return model && enrolledAs(model, target, config.checkpoints) ? [{ model, collection }] : [];
    });
    if (sources.length !== 1) throw new Error(`${target.id}: ${sources.length ? `${sources.length} collections enroll` : 'no collection enrolls'} its configured route and settings`);
    const { model, collection } = sources[0]!;
    const runs = collection.corpus.models.find((candidate) => candidate.id === target.id);
    // The corpus must be the one this model's envelopes were fitted from.
    if (!runs || !model.provenance.includes(`corpus sha256:${corpusDigest(collection.corpus)};`)) throw new Error(`${target.id} was not fitted from its collection's corpus`);
    return { model, runs, collection };
  });
  const models = selected.map((source) => source.model);
  const used = new Set(selected.map((source) => source.collection)).size;
  const bank = validateBank({
    ...collections[0]!.bank, protocol: config.protocol, models,
    calibration: {
      source: `${providerLabel(models.map(enrolledProvider))}; integer-v1; pooled refit of ${used} collections without new requests; each model's provenance records its collection; labels are requested catalog identities, not independent model attestation`,
      heldOutRuns: config.models.reduce((sum, target) => sum + target.validationRuns, 0),
      sequentialValidated: false,
    },
  });
  return attachPooledScoring(bank, selected.map((source) => source.runs), { requestsPerProbe });
}
