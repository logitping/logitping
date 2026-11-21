import { describe, expect, it } from 'vitest';
import type { CollectionSettings, FingerprintBank, ModelFingerprint } from '../src/core/types.js';
import { defaultBank, pooledBank, validateBank } from '../src/data/bank_loader.js';
import { collectionSettingsFor, parseCollectionSettings, withCollectionSettings } from '../src/data/collection_settings.js';
import { syntheticBank } from './fixtures.js';

const D = 'a'.repeat(64);
const tail = '; labels are requested catalog identities, not independent model attestation';
const astraProvenance = `OpenAI API; collected 2026-11-06T22:22:10.199Z; integer-v1; corpus sha256:${D}${tail}; model=gpt-6-astra; api=chat-completions; stream=false; training=10; validation=5; sampling=first-512; max_completion_tokens=8192; cache=none`;
const astra: CollectionSettings = {
  provider: 'openai', route: 'gpt-6-astra', apiFormat: 'chat-completions', tokenLimitField: 'max_completion_tokens', maxTokens: 8192,
  collectedAt: '2026-11-06T22:22:10.199Z', corpusSha256: D,
};

describe('collection settings', () => {
  it('parses each recorded format', () => {
    expect(parseCollectionSettings(astraProvenance)).toEqual(astra);
    expect(parseCollectionSettings(`OpenRouter API; collected 2026-11-11T13:08:34.175Z; integer-v1; corpus sha256:${D}${tail}; model=anthropic/claude-fable-5.2; api=messages; stream=false; training=10; validation=5; sampling=first-512; max_tokens=16384; cache=bypassed`))
      .toEqual({ provider: 'openrouter', route: 'anthropic/claude-fable-5.2', apiFormat: 'messages', tokenLimitField: 'max_tokens', maxTokens: 16384, collectedAt: '2026-11-11T13:08:34.175Z', corpusSha256: D });
    expect(parseCollectionSettings(`Google AI Studio Gemini API; collected 2026-11-19T22:49:17.038Z; integer-v1; corpus sha256:${D}${tail}; model=gemini-4-neon; api=chat-completions; stream=false; training=10; validation=5; sampling=first-512; max_tokens=65536; cache=none`))
      .toEqual({ provider: 'google', route: 'gemini-4-neon', apiFormat: 'chat-completions', tokenLimitField: 'max_tokens', maxTokens: 65536, collectedAt: '2026-11-19T22:49:17.038Z', corpusSha256: D });
  });

  it('returns nothing for provenance without collection settings', () => {
    expect(parseCollectionSettings('SYNTHETIC TEST FIXTURE; no real model measurements')).toBeUndefined();
  });

  it('fills only a missing collection', () => {
    const synthetic = syntheticBank().models[0]!;
    const recorded: ModelFingerprint = { ...synthetic, provenance: astraProvenance };
    expect(withCollectionSettings(recorded)).toEqual({ ...recorded, collection: astra });
    expect(Object.keys(withCollectionSettings(recorded)).at(-1)).toBe('collection');
    const filled: ModelFingerprint = { ...recorded, collection: { ...astra, maxTokens: 1234 } };
    expect(withCollectionSettings(filled)).toBe(filled);
    expect(withCollectionSettings(synthetic)).toBe(synthetic);
  });

  it('finds an enrolled model by its route or id, ignoring case and vendor prefix', () => {
    const bank = syntheticBank();
    bank.models[0]!.collection = astra;
    expect(collectionSettingsFor(bank, 'vendor/SYNTHETIC-17')).toEqual({ id: 'synthetic-17', collection: astra });
    expect(collectionSettingsFor(bank, 'synthetic-1')).toBeUndefined();
    expect(collectionSettingsFor(bank, 'synthetic-287')).toBeUndefined();
  });

  it('validates collection settings', () => {
    const bank = syntheticBank();
    bank.models[0]!.collection = astra;
    expect(() => validateBank(bank)).not.toThrow();
    const broken: Partial<Record<keyof CollectionSettings, unknown>>[] = [
      { apiFormat: 'grpc' }, { tokenLimitField: 'max_output_tokens' }, { maxTokens: 100 }, { corpusSha256: 'xyz' },
      { provider: 'azure' }, { route: '' }, { collectedAt: 'yesterday' },
    ];
    for (const change of broken) {
      const copy = structuredClone(bank);
      copy.models[0]!.collection = { ...astra, ...change } as CollectionSettings;
      expect(() => validateBank(copy)).toThrow(/Invalid bank: collection settings/);
    }
  });

  it("the bundled banks record every model's collection settings", async () => {
    const banks = [defaultBank(), await pooledBank()];
    for (const bank of banks) {
      for (const model of bank.models) {
        expect(model.collection).toBeDefined();
        expect(model.collection).toEqual(parseCollectionSettings(model.provenance));
      }
    }
    const of = (bank: FingerprintBank, id: string) => bank.models.find((model) => model.id === id)?.collection;
    expect(of(banks[0]!, 'gpt-6-astra')).toMatchObject({ apiFormat: 'chat-completions', tokenLimitField: 'max_completion_tokens', maxTokens: 8192 });
    expect(of(banks[0]!, 'claude-fable-5.2')).toMatchObject({ provider: 'openrouter', route: 'anthropic/claude-fable-5.2', maxTokens: 16384 });
    expect(of(banks[0]!, 'gemini-4-neon')).toMatchObject({ provider: 'google', maxTokens: 65536 });
    expect(of(banks[1]!, 'claude-fable-5.2')).toMatchObject({ maxTokens: 4096 });
  });
});
