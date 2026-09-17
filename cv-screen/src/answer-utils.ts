import type { Answers, Questions, ScoreAnswer, Answer } from "./types.js";

/** Normalise a probability-weighted Score onto 0..1 using the criteria in the question. */
export function scoreNorm(answer: ScoreAnswer, levels: number): number {
  if (levels < 2) throw new Error(`need >= 2 levels, got ${levels}`);
  return clamp01(answer.score / (levels - 1));
}

/** Which level the distribution actually favours, plus its description. */
export function topLevel(
  answer: ScoreAnswer,
  criteria: Array<string | { what: string }>,
): { index: number; text: string } {
  let best = 0;
  let bestP = -1;
  for (const [k, v] of Object.entries(answer.probabilities)) {
    const i = Number(k);
    if (Number.isFinite(i) && v > bestP) {
      bestP = v;
      best = i;
    }
  }
  const entry = criteria[best];
  const text = typeof entry === "string" ? entry : (entry?.what ?? `level ${best}`);
  return { index: best, text };
}

export function isNoul(a: Answer | undefined): a is Extract<Answer, { type: "noul" }> {
  return !!a && a.type === "noul";
}
export function isChoice(a: Answer | undefined): a is Extract<Answer, { type: "choice" }> {
  return !!a && a.type === "choice";
}
export function isScore(a: Answer | undefined): a is ScoreAnswer {
  return !!a && a.type === "score";
}

export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Confidence is only defined on Choice and Score answers. Noul answers carry none. */
export function confidenceOf(a: Answer | undefined): number | null {
  return isChoice(a) || isScore(a) ? a.confidence : null;
}

export type { Answers, Questions };
