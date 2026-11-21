import { claimedModel } from '../core/claim.js';
import type { CollectionSettings, FingerprintBank, ModelFingerprint } from '../core/types.js';
import { PROVIDER_LABELS } from './gateway_plan.js';

const LABELS = Object.entries(PROVIDER_LABELS) as [CollectionSettings['provider'], string][];

/**
 * The collection settings the bank updater records in every collected model's provenance, for
 * example `OpenAI API; collected …; corpus sha256:…; …; model=gpt-6.1-sol; api=responses; …;
 * max_output_tokens=8192; …`. Undefined when any of them is missing.
 */
export function parseCollectionSettings(provenance: string): CollectionSettings | undefined {
  const provider = LABELS.find(([, label]) => provenance.startsWith(`${label}; `))?.[0];
  const collectedAt = /; collected ([^;]+);/.exec(provenance)?.[1];
  const corpusSha256 = /corpus sha256:([0-9a-f]{64});/.exec(provenance)?.[1];
  const route = /; model=([^;]+);/.exec(provenance)?.[1];
  const apiFormat = /; api=(chat-completions|responses|messages);/.exec(provenance)?.[1] as CollectionSettings['apiFormat'] | undefined;
  const budget = /; (max_tokens|max_completion_tokens|max_output_tokens)=(\d+);/.exec(provenance);
  if (!provider || !collectedAt || !corpusSha256 || !route || !apiFormat || !budget) return undefined;
  return {
    provider, route, apiFormat, tokenLimitField: budget[1] as CollectionSettings['tokenLimitField'], maxTokens: Number(budget[2]),
    collectedAt, corpusSha256,
  };
}

/** `model` with `collection` filled from its provenance when missing; otherwise `model` itself. */
export function withCollectionSettings(model: ModelFingerprint): ModelFingerprint {
  if (model.collection) return model;
  const collection = parseCollectionSettings(model.provenance);
  return collection ? { ...model, collection } : model;
}

/**
 * The enrolled model a requested model identifier names, and its collection settings: the last
 * `/` segment, ignoring case, equals the model's id, so `openai/gpt-6.1-sol` names `gpt-6.1-sol`.
 */
export function collectionSettingsFor(bank: FingerprintBank, model: string): { id: string; collection: CollectionSettings } | undefined {
  const entry = claimedModel(bank, model);
  return entry?.collection ? { id: entry.id, collection: entry.collection } : undefined;
}
