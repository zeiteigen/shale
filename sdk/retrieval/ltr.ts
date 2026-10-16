/**
 * Coordinate-ascent learning to rank (Metzler & Croft 2007, "Linear feature-based models for information retrieval"):
 * optimise a linear model's weights directly for a ranking metric by line search along one coordinate at a time,
 * keeping any step that improves the objective, until a full round improves by less than `tolerance`. The metric is
 * not differentiable (nDCG over sorted lists), which is why a derivative-free search is used. Linear scores are
 * scale-invariant for ranking, so weights are rescaled to the starting L1 norm after every step (bounded parameters, such
 * as the MMR λ, are excluded from normalisation).
 */

export interface Parameter {
  name: string;
  /** Bounded parameters are searched on [min, max] and never normalised. */
  min?: number;
  max?: number;
  /** Fixed sign: a penalty stays ≤ 0, a reward ≥ 0. */
  sign?: 1 | -1;
}

export interface AscentOptions {
  /** Relative step sizes tried in both directions, as fractions of the coordinate's scale. */
  steps?: number[];
  rounds?: number;
  tolerance?: number;
  /** Progress callback (round, parameter, objective). */
  onStep?: (round: number, name: string, value: number) => void;
}

export interface AscentResult { values: Record<string, number>; objective: number; initial: number; evaluations: number; rounds: number }

const DEFAULT_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2];

const freeOf = (parameters: readonly Parameter[]) => parameters.filter(parameter => parameter.min === undefined && parameter.max === undefined);
const l1 = (values: Record<string, number>, parameters: readonly Parameter[]) => freeOf(parameters).reduce((sum, parameter) => sum + Math.abs(values[parameter.name] ?? 0), 0);

/**
 * Rescale the unbounded parameters to L1 norm `target` (bounded ones untouched); a zero vector is returned as is.
 * Keeping the starting norm leaves any weight that is not tuned (a fixed feature) at its intended relative strength.
 */
export function normalise(values: Record<string, number>, parameters: readonly Parameter[], target = freeOf(parameters).length): Record<string, number> {
  const total = l1(values, parameters);
  if (!total) return { ...values };
  const out = { ...values };
  for (const parameter of freeOf(parameters)) out[parameter.name] = (values[parameter.name] ?? 0) / total * target;
  return out;
}

export function coordinateAscent(initial: Record<string, number>, parameters: readonly Parameter[], objective: (values: Record<string, number>) => number,
  options: AscentOptions = {}): AscentResult {
  const steps = options.steps ?? DEFAULT_STEPS;
  const tolerance = options.tolerance ?? 1e-4;
  const norm = l1(initial, parameters) || freeOf(parameters).length;
  let current = normalise(initial, parameters, norm);
  let best = objective(current);
  const start = best;
  let evaluations = 1, round = 0;
  for (; round < (options.rounds ?? 5); round++) {
    const before = best;
    for (const parameter of parameters) {
      const bounded = parameter.min !== undefined || parameter.max !== undefined;
      const value = current[parameter.name] ?? 0;
      const scale = bounded ? (parameter.max ?? 1) - (parameter.min ?? 0) : Math.max(Math.abs(value), 0.1);
      let chosen = value;
      for (const direction of [1, -1]) for (const step of steps) {
        let next = value + direction * step * scale;
        if (parameter.min !== undefined) next = Math.max(parameter.min, next);
        if (parameter.max !== undefined) next = Math.min(parameter.max, next);
        if (parameter.sign === 1) next = Math.max(0, next);
        if (parameter.sign === -1) next = Math.min(0, next);
        if (next === value) continue;
        const trial = bounded ? { ...current, [parameter.name]: next } : normalise({ ...current, [parameter.name]: next }, parameters, norm);
        const result = objective(trial);
        evaluations++;
        if (result > best + 1e-12) { best = result; chosen = next; }
      }
      if (chosen !== value) {
        current = bounded ? { ...current, [parameter.name]: chosen } : normalise({ ...current, [parameter.name]: chosen }, parameters, norm);
        options.onStep?.(round, parameter.name, best);
      }
    }
    if (best - before < tolerance) { round++; break; }
  }
  return { values: current, objective: best, initial: start, evaluations, rounds: round };
}
