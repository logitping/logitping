import type { Projector } from '../math/nuisance.js';
import { assessOOD } from '../math/ood.js';
import { orderedBlockFeatures } from '../math/ordered_block.js';
import { countEvents, familyLogLikelihoods } from '../math/pooled_features.js';
import { aggregateScores, pairScore } from '../math/pooled_sets.js';
import type { FingerprintBank, ModelScore } from './types.js';

/**
 * Prediction set of a pooled bank over complete responses of `targetSamples` integers each: models
 * that pass their fit and margin cutoffs and whose envelope accepts every response, in bank order.
 */
export function classifyPooled(responses: readonly (readonly number[])[], bank: FingerprintBank, project: Projector): { candidates: string[]; scores: ModelScore[] } {
  const pooled = bank.pooled!;
  const logs = pooled.models.map((model) => model.families.map((family) => family.map(Math.log)));
  // ll[j][m]: per-group log-likelihoods of response j under model m.
  const ll = responses.map((response) => {
    const events = countEvents(response);
    return logs.map((model) => familyLogLikelihoods(events, model));
  });
  const features = responses.map((response) => orderedBlockFeatures(response).vector);
  const pairs = new Map(pooled.pairs.map((pair) => [`${pair.model}\n${pair.competitor}`, pair]));
  const candidates: string[] = [];
  const scores = bank.models.map((model, m): ModelScore => {
    const competitors = bank.models.map((_, o) => o).filter((o) => o !== m);
    const { fit, margin } = aggregateScores(
      ll.map((response) => response[m]!.reduce((sum, value) => sum + value, 0)),
      ll.map((response) => competitors.map((o) => pairScore(
        pairs.get(`${model.id}\n${bank.models[o]!.id}`)!,
        response[m]!.map((value, group) => value - response[o]![group]!),
      ))),
    );
    const profile = model.profiles.find((entry) => entry.sampleCount === bank.protocol.targetSamples)!;
    const distances = features.map((vector) => assessOOD(vector, profile, project));
    const accepted = distances.every((distance) => distance.accepted);
    const { fit: fitCutoff, margin: marginCutoff } = pooled.models[m]!.cutoffs;
    if (accepted && fit >= fitCutoff && margin >= marginCutoff) candidates.push(model.id);
    return {
      id: model.id, weight: null, accepted,
      hellinger: Math.max(...distances.map((distance) => distance.hellinger)),
      mahalanobis: Math.max(...distances.map((distance) => distance.mahalanobis)),
      fit, margin, fitCutoff, marginCutoff,
    };
  });
  return { candidates, scores };
}
