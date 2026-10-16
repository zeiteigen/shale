/**
 * Sparse multinomial logistic regression (softmax) over string features, trained with AdaGrad and L2.
 * Small, deterministic, and serialisable as JSON: models distilled from LLM verdicts live in extension state.
 */
export interface SoftmaxModel {
  classes: number;
  /** Feature name → weight per class. Features unseen in training contribute nothing. */
  weights: Record<string, number[]>;
  bias: number[];
}

export interface TrainingExample { features: string[]; label: number; weight?: number }

/** Deterministic PRNG (mulberry32) so a refit on the same labels yields the same model. */
export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function softmax(scores: number[]): number[] {
  const max = Math.max(...scores);
  const exp = scores.map(score => Math.exp(score - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map(value => value / sum);
}

export function predict(model: SoftmaxModel, features: readonly string[]): number[] {
  const scores = [...model.bias];
  for (const feature of new Set(features)) {
    const weights = model.weights[feature];
    if (weights) for (let c = 0; c < model.classes; c++) scores[c]! += weights[c]!;
  }
  return softmax(scores);
}

export function train(examples: readonly TrainingExample[], options: {
  classes: number; epochs?: number; rate?: number; l2?: number; minCount?: number; seed?: number; prune?: number;
}): SoftmaxModel {
  const { classes } = options;
  const epochs = options.epochs ?? 12, rate = options.rate ?? 0.3, l2 = options.l2 ?? 1e-5, minCount = options.minCount ?? 2;
  // Rare features memorise single records; dropping them keeps the stored model small and general.
  const counts = new Map<string, number>();
  for (const example of examples) for (const feature of new Set(example.features)) counts.set(feature, (counts.get(feature) ?? 0) + 1);
  const index = new Map<string, number>();
  for (const [feature, count] of counts) if (count >= minCount) index.set(feature, index.size);
  const rows = examples.map(example => ({ ids: [...new Set(example.features)].flatMap(f => index.has(f) ? [index.get(f)!] : []),
    label: example.label, weight: example.weight ?? 1 }));
  const w = new Float64Array(index.size * classes), g = new Float64Array(index.size * classes).fill(1e-8);
  const bias = new Float64Array(classes), gBias = new Float64Array(classes).fill(1e-8);
  const order = rows.map((_, i) => i), next = random(options.seed ?? 1);
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
    for (const r of order) {
      const row = rows[r]!;
      const scores = Array.from(bias);
      for (const id of row.ids) for (let c = 0; c < classes; c++) scores[c]! += w[id * classes + c]!;
      const p = softmax(scores);
      for (let c = 0; c < classes; c++) {
        const error = (p[c]! - (c === row.label ? 1 : 0)) * row.weight;
        gBias[c]! += error * error; bias[c]! -= rate * error / Math.sqrt(gBias[c]!);
        for (const id of row.ids) {
          const k = id * classes + c, grad = error + l2 * w[k]!;
          g[k]! += grad * grad; w[k]! -= rate * grad / Math.sqrt(g[k]!);
        }
      }
    }
  }
  const weights: Record<string, number[]> = {};
  const prune = options.prune ?? 1e-3;
  for (const [feature, id] of index) {
    const row = Array.from(w.subarray(id * classes, (id + 1) * classes));
    if (row.some(value => Math.abs(value) >= prune)) weights[feature] = row.map(value => Math.round(value * 1e4) / 1e4);
  }
  return { classes, weights, bias: Array.from(bias, value => Math.round(value * 1e4) / 1e4) };
}
