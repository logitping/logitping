import { createHash, randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { INTEGER_MAX, INTEGER_MIN } from '../math/ordered_block.js';
import { integerPrompt } from '../probes/templates.js';
import { errorCode, READ_NONBLOCKING, syncDirectory } from '../util/fs.js';
import { isIntegerInRange, isRecord } from '../util/validate.js';
import type { EnrollmentInput } from './enrollment.js';
import { MAX_REQUESTS, type GatewayBankConfig } from './gateway_config.js';

type Rejections = { training: number; validation: number };

export interface GatewayCheckpoint {
  schemaVersion: 1;
  configHash: string;
  collectedAt: string;
  requestsSent: number;
  models: EnrollmentInput['models'];
  shortResponses: Rejections[];
  invalidResponses: Rejections[];
}

// Covers the largest allowed plan (1000 requests of 16384 integers), including metadata.
const MAX_CHECKPOINT_BYTES = 80 * 1024 * 1024;

function configHash(config: GatewayBankConfig, transport: string = config.protocol.transport): string {
  const gateway = config.models.some((target) => target.provider === 'cloudflare') ? config.gateway : undefined;
  return createHash('sha256').update(JSON.stringify({
    // Increment when acceptance/sampling semantics change. Include actual prompt text
    // so editing a template cannot silently reuse probes from an older prompt.
    collectionVersion: 1,
    protocol: { ...config.protocol, transport },
    prompt: integerPrompt(config.protocol.targetSamples, config.protocol.language),
    checkpoints: config.checkpoints,
    // Omit the default provider so Cloudflare progress saved before OpenRouter support resumes.
    models: config.models.map(({ provider, ...target }) => provider === 'cloudflare' ? target : { ...target, provider }),
    // Only Cloudflare routes depend on an account and gateway; omitted keys keep older digests.
    accountId: gateway?.accountId,
    gatewayId: gateway?.gatewayId,
    // Credentials may rotate; operational limits may change without changing samples.
  })).digest('hex');
}

export function newGatewayCheckpoint(config: GatewayBankConfig, collectedAt: string): GatewayCheckpoint {
  return {
    schemaVersion: 1, configHash: configHash(config), collectedAt, requestsSent: 0,
    models: config.models.map(({ id, family }) => ({ id, family, training: [], validation: [] })),
    shortResponses: config.models.map(() => ({ training: 0, validation: 0 })),
    invalidResponses: config.models.map(() => ({ training: 0, validation: 0 })),
  };
}

export function completedRuns(state: GatewayCheckpoint): number {
  return state.models.reduce((sum, model) => sum + model.training.length + model.validation.length, 0);
}

function count(value: unknown): value is number {
  return isIntegerInRange(value, 0, MAX_REQUESTS);
}

function invalid(): never {
  throw new Error('Invalid bank checkpoint; restore a valid checkpoint or use --restart to discard saved progress');
}

function parseCheckpoint(value: unknown, config: GatewayBankConfig): GatewayCheckpoint {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.configHash !== 'string') invalid();
  const current = configHash(config);
  // Earlier versions labeled the same mixed-format collection `openai`; the next save migrates it.
  if (value.configHash !== current && value.configHash !== configHash(config, 'openai')) {
    throw new Error('Bank checkpoint does not match the collection configuration; restore the original model/protocol settings, use another output path, or use --restart to discard saved progress');
  }
  if (typeof value.collectedAt !== 'string' || !Number.isFinite(Date.parse(value.collectedAt)) ||
      new Date(value.collectedAt).toISOString() !== value.collectedAt || !count(value.requestsSent) ||
      !Array.isArray(value.models) || value.models.length !== config.models.length) invalid();
  const models: EnrollmentInput['models'] = [];
  for (const [index, target] of config.models.entries()) {
    const model: unknown = value.models[index];
    if (!isRecord(model) || model.id !== target.id || model.family !== target.family) invalid();
    const phases = { training: [] as number[][], validation: [] as number[][] };
    for (const phase of ['training', 'validation'] as const) {
      const runs = model[phase];
      const limit = phase === 'training' ? target.trainingRuns : target.validationRuns;
      if (!Array.isArray(runs) || runs.length > limit) invalid();
      for (const samples of runs) {
        if (!Array.isArray(samples) || samples.length !== target.sampleCount ||
            !samples.every((n: unknown) => isIntegerInRange(n, INTEGER_MIN, INTEGER_MAX))) invalid();
        phases[phase].push(samples as number[]);
      }
    }
    models.push({ id: target.id, family: target.family, ...phases });
  }
  const rejections = (entries: unknown): Rejections[] => {
    if (!Array.isArray(entries) || entries.length !== models.length) invalid();
    return entries.map((entry: unknown) => {
      if (!isRecord(entry) || !count(entry.training) || !count(entry.validation)) invalid();
      return { training: entry.training, validation: entry.validation };
    });
  };
  const state: GatewayCheckpoint = {
    schemaVersion: 1, configHash: current, collectedAt: value.collectedAt,
    requestsSent: value.requestsSent, models,
    shortResponses: rejections(value.shortResponses), invalidResponses: rejections(value.invalidResponses),
  };
  const rejected = [...state.shortResponses, ...state.invalidResponses]
    .reduce((sum, counts) => sum + counts.training + counts.validation, 0);
  if (completedRuns(state) + rejected > state.requestsSent) invalid();
  // Saved runs must be a prefix of the collection schedule. In particular, held-out
  // validation cannot precede unfinished training, and no run can be skipped.
  let missing = false;
  for (const phase of ['training', 'validation'] as const) {
    const key = phase === 'training' ? 'trainingRuns' : 'validationRuns';
    const rounds = Math.max(...config.models.map((target) => target[key]));
    for (let round = 0; round < rounds; round++) {
      for (const [index, target] of config.models.entries()) {
        if (round >= target[key]) continue;
        if (round >= state.models[index]![phase].length) missing = true;
        else if (missing) invalid();
      }
    }
  }
  return state;
}

export async function readGatewayCheckpoint(path: string, config: GatewayBankConfig): Promise<GatewayCheckpoint | undefined> {
  let file: Awaited<ReturnType<typeof open>>;
  try { file = await open(path, READ_NONBLOCKING); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_CHECKPOINT_BYTES) invalid();
    const text = await file.readFile('utf8');
    if (Buffer.byteLength(text) > MAX_CHECKPOINT_BYTES) invalid();
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { invalid(); } // Never echo arbitrary checkpoint contents or JSON parse excerpts.
    return parseCheckpoint(value, config);
  } finally { await file.close(); }
}

export async function saveGatewayCheckpoint(path: string, state: GatewayCheckpoint): Promise<void> {
  const serialized = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(serialized) > MAX_CHECKPOINT_BYTES) throw new Error('Bank checkpoint exceeds the size limit');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(serialized); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    // A reservation must survive power loss, or a paid request could go uncounted.
    await syncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }); }
}
