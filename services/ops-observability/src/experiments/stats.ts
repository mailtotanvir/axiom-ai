/**
 * Experiment statistics (O4): per-arm outcome summaries with 95% Wald
 * confidence intervals and Bayesian-style win probabilities via seeded
 * Monte-Carlo sampling from normal posteriors. Pure functions, fully
 * deterministic for a given seed.
 */

export interface ArmSummary {
  n: number;
  mean: number;
  stdErr: number;
  ci95: [number, number];
}

/** Sample summary of one arm's outcome values. */
export function summarize(values: number[]): ArmSummary {
  const n = values.length;
  if (n === 0) {
    return { n: 0, mean: 0, stdErr: 0, ci95: [0, 0] };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  if (n === 1) {
    return { n, mean, stdErr: 0, ci95: [mean, mean] };
  }
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const stdErr = Math.sqrt(variance / n);
  // 1.96 ≈ z_{0.975}; fine at the report's precision for n ≥ 2.
  const halfWidth = 1.96 * stdErr;
  return { n, mean, stdErr, ci95: [mean - halfWidth, mean + halfWidth] };
}

/** Deterministic PRNG (mulberry32); adequate for Monte-Carlo shares. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * P(arm has the highest true mean) approximated by drawing true means from
 * N(observed mean, observed stdErr) per arm. Arms without observations get
 * a wide uninformative posterior so they never win by default.
 */
export function winProbabilities(
  summaries: Record<string, ArmSummary>,
  seed = 42,
  samples = 10_000,
): Record<string, number> {
  const arms = Object.keys(summaries).sort();
  if (arms.length === 0) {
    return {};
  }
  if (arms.length === 1) {
    return { [arms[0]!]: 1 };
  }

  const random = mulberry32(seed);
  const wins: Record<string, number> = {};
  for (const arm of arms) {
    wins[arm] = 0;
  }

  // Box-Muller pairs; regenerate u2 across iterations.
  let spare: number | undefined;
  const normal = (mean: number, sigma: number): number => {
    if (spare !== undefined) {
      const value = spare;
      spare = undefined;
      return mean + sigma * value;
    }
    let u1 = random();
    while (u1 === 0) {
      u1 = random();
    }
    const u2 = random();
    const magnitude = Math.sqrt(-2 * Math.log(u1));
    spare = magnitude * Math.sin(2 * Math.PI * u2);
    return mean + sigma * magnitude * Math.cos(2 * Math.PI * u2);
  };

  const posteriors = arms.map((arm) => {
    const summary = summaries[arm]!;
    // No/one observation: flat-ish prior around zero.
    const priorSigma = 1;
    return {
      arm,
      mean: summary.n > 0 ? summary.mean : 0,
      sigma: summary.stdErr > 0 ? summary.stdErr : priorSigma,
    };
  });

  for (let sample = 0; sample < samples; sample += 1) {
    let bestArm = posteriors[0]!.arm;
    let bestValue = -Number.MAX_VALUE;
    for (const posterior of posteriors) {
      const draw = normal(posterior.mean, posterior.sigma);
      if (draw > bestValue) {
        bestValue = draw;
        bestArm = posterior.arm;
      }
    }
    wins[bestArm] = (wins[bestArm] ?? 0) + 1;
  }

  const result: Record<string, number> = {};
  for (const arm of arms) {
    result[arm] = wins[arm]! / samples;
  }
  return result;
}
