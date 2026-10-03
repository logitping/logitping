import { assertVector } from './hellinger.js';

export function dot(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new RangeError('Vector dimensions must match');
  let result = 0;
  for (let i = 0; i < a.length; i++) result += a[i]! * b[i]!;
  return result;
}

/** Modified Gram–Schmidt with reorthogonalization; dependent directions are dropped. */
export function gramSchmidt(directions: readonly (readonly number[])[], tolerance = 1e-10): number[][] {
  if (!Number.isFinite(tolerance) || tolerance <= 0) throw new RangeError('Invalid tolerance');
  const basis: number[][] = [];
  const dimension = directions[0]?.length;
  for (const direction of directions) {
    assertVector(direction);
    if (direction.length !== dimension) throw new RangeError('Direction dimensions must match');
    // Spreading a large vector into Math.hypot() can exceed the argument limit.
    const originalNorm = Math.sqrt(dot(direction, direction));
    if (!originalNorm) continue;
    const v = direction.map((x) => x / originalNorm);
    for (let pass = 0; pass < 2; pass++) {
      for (const axis of basis) {
        const coefficient = dot(v, axis);
        for (let i = 0; i < v.length; i++) v[i]! -= coefficient * axis[i]!;
      }
    }
    const norm = Math.sqrt(dot(v, v));
    if (norm > tolerance) basis.push(v.map((x) => x / norm));
  }
  return basis;
}

export type Projector = (vector: readonly number[]) => number[];

/** Compile once: applies (I - QQ^T)v without materializing a dense matrix. */
export function createNuisanceProjector(directions: readonly (readonly number[])[]): Projector {
  const basis = gramSchmidt(directions);
  return (vector: readonly number[]): number[] => {
    assertVector(vector);
    if (directions.length && vector.length !== directions[0]!.length) {
      throw new RangeError('Projection dimensions must match');
    }
    const residual = [...vector];
    for (const axis of basis) {
      const coefficient = dot(vector, axis);
      for (let i = 0; i < residual.length; i++) residual[i]! -= coefficient * axis[i]!;
    }
    return residual;
  };
}

export function projectNuisance(vector: readonly number[], directions: readonly (readonly number[])[]): number[] {
  return createNuisanceProjector(directions)(vector);
}
