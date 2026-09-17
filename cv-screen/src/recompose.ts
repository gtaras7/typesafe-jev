/**
 * Saved runs, re-scored under a new policy, with no API calls.
 *
 * This is the payoff of keeping the judgments separate from the arithmetic: the model
 * was asked how many years of experience a candidate has, not whether they are a good
 * fit. Changing a weight, a threshold or a cap therefore changes the shortlist in
 * milliseconds and costs nothing. Adding a NEW question is the one thing that does need
 * the model again, and only for the candidates that have no answer for it yet.
 *
 * Every row keeps the questions and the policy it was judged under, so a re-score is
 * always reproducible and never silently reinterprets an old answer against a new
 * scale.
 */

import { compose } from "./compose.js";
import type { ScreenResult as ComposeResult } from "./compose.js";
import { policyQuestionIds } from "./questions.js";
import { buildQuestions, TODAY_TOKEN } from "./questions.js";
import type { Policy } from "./policy.js";
import { parseJson, type RunStore, type StoredRun } from "./store.js";
import type { Answers, Questions } from "./types.js";
import { FOOD_INDUSTRY_POLICY } from "./presets.js";

export interface RecomposeOutcome {
  policyId: string;
  /** How many stored candidates were re-scored. */
  n: number;
  /** How many of those now show different numbers or a different verdict. */
  changed: number;
  /** Candidates that gain a question they have never been asked. */
  requiresInference: number;
  ms: number;
  /** Nothing was sent to the model. This is always 0, and saying so is the point. */
  tokens: 0;
}

/** Question ids the policy asks that this CV has no answer for. */
export function missingQuestions(policy: Policy, answers: Answers): string[] {
  return policyQuestionIds(policy).filter((id) => !(id in answers));
}

/**
 * The questions a stored row was judged under. Falls back to rebuilding them from the
 * policy recorded at the time, and then to the original single-role policy, so rows
 * written before this app existed still re-score correctly instead of throwing.
 */
export function storedQuestions(row: StoredRun, today = new Date().toISOString().slice(0, 10)): Questions {
  const stored = parseJson<Questions>(row.questions_json || "{}", {});
  if (Object.keys(stored).length) return stored;
  // `?? default` is not enough here: an old row has the string "{}" on disk, which
  // parses to an empty object that would then be mistaken for a policy.
  const raw = parseJson<Partial<Policy> | null>(row.policy_json || "null", null);
  const policyAtTheTime = raw && typeof raw === "object" && "roleTitle" in raw ? (raw as Policy) : null;
  return buildQuestions(policyAtTheTime ?? FOOD_INDUSTRY_POLICY, today);
}

/**
 * Re-score every stored candidate. Pure arithmetic over stored judgments: no network,
 * no model, no tokens. Returns what changed so the UI can say it in plain words.
 */
export function recomposeAll(store: RunStore, policy: Policy): RecomposeOutcome {
  const started = Date.now();
  const rows = store.all(100_000);
  let changed = 0;
  let requiresInference = 0;

  for (const row of rows) {
    const answers = parseJson<Answers>(row.answers_json, {});
    const questions = storedQuestions(row);
    const missing = missingQuestions(policy, answers);
    const needsRescan = missing.length > 0;
    if (needsRescan) requiresInference++;

    const result = compose(policy, questions, answers, {
      name: row.candidate_name,
      email: row.candidate_email,
    });

    /**
     * A rule change is not the only thing that moves a row: the words do too. A renamed sector, a
     * reworded review reason or a relabelled dimension changes what the table, the detail panel and
     * the CSV say. Without this, a row whose numbers happen to come out identical keeps the old
     * wording forever, and the fix looks like it did nothing.
     */
    const before = parseJson<ComposeResult>(row.result_json || "{}", {} as ComposeResult);
    const wording = (r: Partial<ComposeResult>) =>
      JSON.stringify({
        dimensions: (r.dimensions ?? []).map((d) => [d.id, d.label]),
        reviewReasons: r.reviewReasons ?? [],
        appliedCaps: r.appliedCaps ?? [],
        notes: r.notes ?? [],
      });

    const differs =
      Math.abs(result.composite - row.composite) > 1e-9 ||
      result.recommendation !== row.recommendation ||
      result.needsHumanReview !== Boolean(row.needs_review) ||
      needsRescan !== Boolean(row.needs_rescan) ||
      row.scored_policy_id !== policy.id ||
      wording(before) !== wording(result);

    if (!differs) continue;
    changed++;

    store.updateComposition(row.id, {
      scoredPolicyId: policy.id,
      composite: result.composite,
      rawComposite: result.rawComposite,
      capped: result.capped,
      recommendation: result.recommendation,
      needsReview: result.needsHumanReview,
      needsRescan,
      reviewReasons: result.reviewReasons,
      fields: result.fields,
      result,
    });
  }

  return {
    policyId: policy.id,
    n: rows.length,
    changed,
    requiresInference,
    ms: Date.now() - started,
    tokens: 0,
  };
}

/** Question ids the current policy asks, for showing the user what will be sent. */
export function askedQuestionIds(policy: Policy): string[] {
  return policyQuestionIds(policy);
}

export { TODAY_TOKEN };
