/**
 * Composite scoring: pure functions only, no network, no model.
 *
 * Every number the recruiter sees is computed here from the raw judgments, so the
 * arithmetic is testable and the policy is reviewable. Changing a weight or a
 * threshold does not invalidate the judgments, so nothing here needs a new API call.
 * That property is what the whole app rests on: a folder of 300 CVs is judged once,
 * and then re-scored in milliseconds every time the user moves a slider.
 *
 * Two additive changes from the single-role version:
 *
 *  1. Extra fields. The six core dimensions keep their exact, measured logic; anything
 *     the user switches on is scored generically from its own question type.
 *  2. Weights are normalised by their own sum, so adding a field never silently
 *     rescales the existing ones. When the weights already sum to 1 the normaliser is
 *     exactly 1, which is why the numbers did not move when the extra fields arrived.
 */

import type { Answers, Questions } from "./types.js";
import type { ExtraField, Policy } from "./policy.js";
import { asPolicy, CORE_DIMENSIONS } from "./policy.js";
import type { RoleSpec } from "./role-spec.js";
import {
  clamp01,
  confidenceOf,
  isChoice,
  isNoul,
  isScore,
  round,
  scoreNorm,
  topLevel,
} from "./answer-utils.js";

export type Recommendation = "INTERVIEW" | "MAYBE" | "PASS";

export interface DimensionResult {
  id: string;
  label: string;
  weight: number;
  /** 0..1, normalised */
  value: number;
  /** weighted contribution to the match score: weight * value / normaliser */
  contribution: number;
  /** how the value was derived, for audit */
  basis: string;
  unknown: boolean;
  confidence: number | null;
  /** Extra fields only: shown and optionally reviewed, but never scored. */
  mode?: "weight" | "flag";
  /** Extra fields only: the question type that produced this. */
  kind?: "noul" | "choice" | "score";
  /** Extra fields only: the answer as a short string, for a table column. */
  display?: string;
}

export interface ScreenResult {
  policyId: string;
  roleTitle: string;
  candidate: { name: string; email: string };
  composite: number;
  rawComposite: number;
  capped: boolean;
  appliedCaps: string[];
  dimensions: DimensionResult[];
  gates: {
    educationAccepted: boolean;
    foodSectorPresent: boolean;
    stabilityRedFlag: boolean;
  };
  priority: { flagged: boolean; probability: number; keywords: string[] };
  recommendation: Recommendation;
  needsHumanReview: boolean;
  reviewReasons: string[];
  /** Soft signals worth reading, but not reasons to treat the row as unresolved. */
  notes: string[];
  strengths: string[];
  gaps: string[];
  explanation: string;
  /** Extra field id -> short answer, for the spreadsheet columns. */
  fields: Record<string, string>;
  /**
   * True when a question the current policy asks has no stored answer, so this score
   * is provisional and the candidate should be re-scanned. It never happens for a CV
   * screened under the current policy.
   */
  awaitingRescan: boolean;
}

const DIM_LABELS: Record<string, string> = {
  experience_years: "Experience (years)",
  education: "Education category",
  food_sector: "Sector depth",
  age_over_28: "Age over 28",
  military: "Military service",
  stability: "Job stability",
};

/**
 * The role's own words for the sector it is hiring in, stripped of the leading article so it reads
 * mid sentence ("food sector", "frontend development with React or React Native").
 */
export function sectorPhrase(policy: Policy): string {
  return String(policy.sector?.label ?? "").trim().replace(/^the\s+/i, "") || "the sector";
}

/**
 * The heading a dimension is shown under.
 *
 * The sector dimension belongs to the role being hired for, not to this app. The food industry is
 * the preset this project started with, and labelling a column "Food-sector depth" while the search
 * is for a frontend developer or a warehouse supervisor is simply wrong. The policy carries the
 * sector's own phrase, so use it, and fall back to a generic heading when the role's phrasing is too
 * long to sit at the top of a table column.
 */
export function dimensionLabel(id: string, policy: Policy): string {
  if (id !== "food_sector") return DIM_LABELS[id] ?? id;
  const bare = sectorPhrase(policy);
  // A placeholder or over-long phrase gets the generic heading. A column title has to stay short,
  // and neither "Required sector depth" nor a forty character role description belongs at the top
  // of a table.
  const generic = /^(the sector|the required sector|required sector|sector experience)$/i.test(bare) || bare.length > 24 || /depth$/i.test(bare);
  if (generic) return "Sector depth";
  return bare.charAt(0).toUpperCase() + bare.slice(1) + " depth";
}

function scoreLevels(qs: Questions, id: string): Array<string | { what: string; examples?: string[] }> {
  const q = qs[id];
  if (!q || q.type !== "score") throw new Error(`question ${id} is not a score`);
  return q.criteria;
}

type ProbabilityZone = "low" | "mid" | "high";

/**
 * Classify a judgment probability against the review band. "low" and "high" are
 * decisive; "mid" is too close to call. `expected` (1 - p) is the value to score in
 * the mid zone, so a 51/49 call contributes its expectation instead of a hard 0/1.
 */
function threeZone(p: number, policy: Policy): { zone: ProbabilityZone; expected: number } {
  if (p >= policy.review.borderlineHigh) return { zone: "high", expected: 1 - p };
  if (p <= policy.review.borderlineLow) return { zone: "low", expected: 1 - p };
  return { zone: "mid", expected: 1 - p };
}

/** The credit a choice option is worth, and whether the scale covers it at all. */
function choiceCredit(field: ExtraField, option: string, unknownCredit: number): { value: number; known: boolean } {
  const v = field.choiceValues?.[option];
  if (typeof v === "number" && Number.isFinite(v)) return { value: clamp01(v), known: true };
  return { value: unknownCredit, known: false };
}

export function compose(
  policyOrRole: Policy | RoleSpec,
  questions: Questions,
  answers: Answers,
  candidate: { name: string; email: string },
): ScreenResult {
  const policy = asPolicy(policyOrRole);
  const reviewReasons: string[] = [];
  const notes: string[] = [];
  const dims: DimensionResult[] = [];
  const fields: Record<string, string> = {};
  let awaitingRescan = false;

  const { minConfidence, borderlineLow, borderlineHigh } = policy.review;
  const confidenceNotes: string[] = [];

  /** Flag a gate probability that sits too close to the 0.5 boundary to call. */
  function checkBorderline(id: string, p: number, what: string) {
    if (p > borderlineLow && p < borderlineHigh) {
      reviewReasons.push(`${what} is borderline (p=${round(p, 3)})`);
    }
  }

  function push(
    id: string,
    value: number,
    basis: string,
    opts: {
      unknown?: boolean;
      confidence?: number | null;
      qid?: string;
      label?: string;
      mode?: "weight" | "flag";
      kind?: "noul" | "choice" | "score";
      display?: string;
      /** Extra fields carry their own weight; core dimensions look theirs up by id. */
      weight?: number;
    } = {},
  ) {
    const weight = opts.mode === "flag" ? 0 : (opts.weight ?? policy.weights[id] ?? 0);
    const v = clamp01(value);
    const label = opts.label ?? dimensionLabel(id, policy);
    dims.push({
      id,
      label,
      weight,
      value: round(v),
      // Filled in once every dimension is known: see the normaliser below.
      contribution: 0,
      basis,
      unknown: opts.unknown ?? false,
      confidence: opts.confidence ?? null,
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.display !== undefined ? { display: opts.display } : {}),
    });
    const conf = opts.confidence ?? null;
    if (conf !== null && conf < minConfidence && opts.qid && opts.mode !== "flag") {
      // A close call is recorded, but on its own it is not a reason to wake a recruiter:
      // a Choice with four plausible options spreads its own probability, and the docs are
      // explicit that low confidence on a harmless preference choice means little. It is
      // promoted to a review reason below, and only when the final score sits on a line.
      confidenceNotes.push(`${label} was a close call (confidence ${round(conf, 2)})`);
    }
  }

  /** Shared tail for an extra field of any kind. */
  function pushExtra(field: ExtraField) {
    const answer = answers[field.id];
    if (!answer) {
      // A policy that asks something this CV was never asked. Do not invent a score for
      // it: leave it out of the arithmetic and say so, so the UI can offer a re-scan.
      awaitingRescan = true;
      reviewReasons.push(`${field.label} has not been asked about this CV yet`);
      return;
    }

    const mode = field.mode ?? "weight";
    const base = {
      label: field.label,
      mode,
      kind: field.kind,
      qid: field.id,
      weight: field.weight,
    } as const;

    if (field.kind === "noul") {
      if (!isNoul(answer)) {
        reviewReasons.push(`${field.label} answer missing from the response`);
        return;
      }
      const p = answer.noul;
      const value = field.noulPolarity === "yes_is_bad" ? 1 - p : p;
      const yes = p >= 0.5;
      fields[field.id] = yes ? "yes" : "no";
      push(field.id, value, `${yes ? "yes" : "no"} (p=${round(p, 3)})`, {
        ...base,
        display: yes ? "yes" : "no",
        confidence: null,
      });
      if (typeof field.reviewWhen?.noulAbove === "number" && p >= field.reviewWhen.noulAbove) {
        reviewReasons.push(`${field.label} may be an issue (p=${round(p, 3)})`);
      }
      return;
    }

    if (field.kind === "choice") {
      if (!isChoice(answer)) {
        reviewReasons.push(`${field.label} answer missing from the response`);
        return;
      }
      const { value, known } = choiceCredit(field, answer.choice, policy.unknownCredit);
      const label = humaniseOption(answer.choice);
      fields[field.id] = answer.choice;
      push(field.id, value, `${label}${known ? "" : ", partial credit"}`, {
        ...base,
        unknown: !known,
        display: label,
        confidence: answer.confidence,
      });
      if (field.reviewWhen?.options?.includes(answer.choice)) {
        reviewReasons.push(`${field.label} came back as ${label}, which needs a person to read`);
      }
      return;
    }

    // score
    if (!isScore(answer)) {
      reviewReasons.push(`${field.label} answer missing from the response`);
      return;
    }
    const q = questions[field.id];
    const levels = q && q.type === "score" ? q.criteria : Array.isArray(field.criteria) ? field.criteria : [];
    if (levels.length < 2) {
      reviewReasons.push(`${field.label} has fewer than two levels and cannot be scored`);
      return;
    }
    const norm = scoreNorm(answer, levels.length);
    const top = topLevel(answer, levels);
    fields[field.id] = String(top.index);
    push(field.id, norm, `level ${top.index}: ${top.text}`, {
      ...base,
      display: String(top.index),
      confidence: answer.confidence,
    });
  }

  // ---------- 1. Experience ----------
  if ((policy.weights.experience_years ?? 0) > 0) {
    const presence = answers.experience_determinable;
    const level = answers.experience_level;
    if (!isNoul(presence) || !isScore(level)) {
      push("experience_years", policy.unknownCredit, "answer missing from response", {
        unknown: true,
      });
      reviewReasons.push("Experience answers missing from the response");
    } else {
      const p = presence.noul;
      checkBorderline("experience_determinable", p, "Experience determinability");
      if (p < 0.5) {
        push(
          "experience_years",
          policy.unknownCredit,
          `experience not determinable from the CV (p=${round(p, 3)}), partial credit`,
          { unknown: true, qid: "experience_level", confidence: confidenceOf(level) },
        );
      } else {
        const levels = scoreLevels(questions, "experience_level");
        const norm = scoreNorm(level, levels.length);
        const top = topLevel(level, levels);
        push("experience_years", norm, `level ${top.index}: ${top.text}`, {
          qid: "experience_level",
          confidence: level.confidence,
        });
      }
    }
  }

  // ---------- 2. Education (also a gate) ----------
  // Judged only when the policy named accepted categories. A weight without categories cannot be
  // answered in the candidate's favour, so scoring it would cap everyone at the education cap.
  const educationAsked = Boolean(questions.education) && policy.acceptedEducation.length > 0;
  let educationAccepted = false;
  if (educationAsked) {
    const edu = answers.education;
    if (!isChoice(edu)) {
      push("education", 0, "answer missing from response");
      reviewReasons.push("Education answer missing from the response");
    } else {
      // The distribution tells us how much probability mass rejects the candidate,
      // so the graded signal and the gate come from the same answer.
      const pReject = edu.probabilities[policy.educationNoMatchKey] ?? 0;
      const value = 1 - pReject;
      educationAccepted = edu.choice !== policy.educationNoMatchKey && value >= 0.5;
      push(
        "education",
        value,
        educationAccepted
          ? `accepted category: ${edu.choice}`
          : `no accepted category (${edu.choice}, p(no match)=${round(pReject, 3)})`,
        { confidence: edu.confidence, qid: "education" },
      );
      checkBorderline("education", value, "Education eligibility");
    }
  }

  // ---------- 3. Food sector ----------
  let foodSectorPresent = false;
  let foodSectorP: number | null = null;
  const sectorNeeded = policy.sector.enabled || (policy.weights.food_sector ?? 0) > 0;
  if (sectorNeeded) {
    const presence = answers.food_sector_present;
    const depth = answers.food_sector_depth;
    if (isNoul(presence)) {
      foodSectorP = presence.noul;
      // The gate keeps the model's best call (p >= 0.5) so downstream consumers
      // (the store column, the report, the generated workflow) stay unchanged.
      foodSectorPresent = presence.noul >= 0.5;
      checkBorderline("food_sector_present", presence.noul, `${sectorPhrase(policy)} presence`);
    }
    if (!isScore(depth)) {
      push("food_sector", 0, "answer missing from response");
      reviewReasons.push(`${sectorPhrase(policy)} depth answer missing from the response`);
    } else {
      const levels = scoreLevels(questions, "food_sector_depth");
      const norm = scoreNorm(depth, levels.length);
      const top = topLevel(depth, levels);
      push("food_sector", norm, `level ${top.index}: ${top.text}`, {
        qid: "food_sector_depth",
        confidence: depth.confidence,
      });
    }
  }

  // ---------- 4. Age over 28 (policy, not a model judgment) ----------
  if (policy.age.enabled && (policy.weights.age_over_28 ?? 0) > 0) {
    const age = answers.age_evidence;
    const MAP: Record<string, { v: number; basis: string; unknown?: boolean }> = {
      over_28_stated: {
        v: 1,
        basis: `direct evidence places candidate over ${policy.age.minAge}`,
      },
      under_28_stated: {
        v: 0,
        basis: `direct evidence places candidate at or below ${policy.age.minAge}`,
      },
      inferable_indirectly: {
        v: policy.unknownCredit,
        basis: "age only inferable indirectly, partial credit",
        unknown: true,
      },
      not_stated: {
        v: policy.unknownCredit,
        basis: "age not stated, partial credit",
        unknown: true,
      },
    };
    if (!isChoice(age)) {
      push("age_over_28", policy.unknownCredit, "answer missing from response", { unknown: true });
      reviewReasons.push("Age evidence answer missing from the response");
    } else {
      const m = MAP[age.choice];
      if (!m) {
        push("age_over_28", policy.unknownCredit, `unmapped option ${age.choice}`, { unknown: true });
        reviewReasons.push(`Unexpected age option: ${age.choice}`);
      } else {
        push("age_over_28", m.v, m.basis, {
          unknown: m.unknown,
          confidence: age.confidence,
          qid: "age_evidence",
        });
      }
    }
  }

  // ---------- 5. Military service ----------
  if (policy.military.enabled && (policy.weights.military ?? 0) > 0) {
    const mil = answers.military_status;
    const MAP: Record<string, { v: number; basis: string; unknown?: boolean }> = {
      completed: { v: 1, basis: "service completed" },
      exempted: { v: 1, basis: "exempted or waived" },
      not_applicable_female: { v: 1, basis: "not applicable, full credit per policy" },
      pending_or_not_completed: { v: 0, basis: "service not completed" },
      not_stated: { v: 0.5, basis: "status not stated, partial credit", unknown: true },
    };
    if (!isChoice(mil)) {
      push("military", 0.5, "answer missing from response", { unknown: true });
      reviewReasons.push("Military service answer missing from the response");
    } else {
      const m = MAP[mil.choice];
      if (!m) {
        push("military", 0.5, `unmapped option ${mil.choice}`, { unknown: true });
        reviewReasons.push(`Unexpected military option: ${mil.choice}`);
      } else {
        push("military", m.v, m.basis, {
          unknown: m.unknown,
          confidence: mil.confidence,
          qid: "military_status",
        });
      }
    }
  }

  // ---------- 6. Stability ----------
  let stabilityRedFlag = false;
  if ((policy.weights.stability ?? 0) > 0) {
    const flag = answers.stability_red_flag;
    if (!isNoul(flag)) {
      push("stability", 0.5, "answer missing from response", { unknown: true });
      reviewReasons.push("Job stability answer missing from the response");
    } else {
      const p = flag.noul;
      checkBorderline("stability_red_flag", p, "Job stability red flag");
      // The gate keeps the model's best call for downstream columns; only the
      // scored value below uses the three-zone rule, so a 51/49 call is not a
      // decisive zero on a dimension worth 0.15 of the total.
      stabilityRedFlag = p >= 0.5;
      const tz = threeZone(p, policy);
      if (tz.zone === "high") {
        push(
          "stability",
          0,
          `red flag: more than ${policy.stability.maxEmployers} employers (p=${round(p, 3)})`,
        );
      } else if (tz.zone === "low") {
        // Criterion 6 of the original spec is binary: over the employer limit scores
        // zero, at or under it scores full marks. Using 1 - p here would have made a
        // perfect composite unreachable, so it stays binary.
        push(
          "stability",
          1,
          `no red flag, at or under the ${policy.stability.maxEmployers} employer limit (p(flag)=${round(p, 3)})`,
        );
      } else {
        // Uncertain: score the expected value. checkBorderline above already added
        // the review reason for this band.
        push(
          "stability",
          tz.expected,
          `red flag uncertain (p=${round(p, 3)}), scored ${round(tz.expected, 3)}`,
        );
      }
    }
  }

  // ---------- 7. Extra fields the user switched on ----------
  for (const field of policy.extraFields) {
    if (!field.enabled) continue;
    if ((CORE_DIMENSIONS as readonly string[]).includes(field.id)) continue;
    pushExtra(field);
  }

  // ---------- Compose ----------
  //
  // The normaliser is the sum of the weights that were actually scored, not of every
  // weight the policy declares. A question this CV was never asked therefore does not
  // dilute its score: the row is marked as provisional instead, and the user is offered
  // one more pass. When the weights already sum to 1 the normaliser is exactly 1, which
  // keeps this arithmetic identical to every earlier number.
  const scoredWeight = dims
    .filter((d) => d.mode !== "flag")
    .reduce((s, d) => s + d.weight, 0);
  const normaliser = scoredWeight <= 0 || Math.abs(scoredWeight - 1) < 1e-9 ? 1 : scoredWeight;
  for (const d of dims) d.contribution = round((d.weight * d.value) / normaliser);

  const rawComposite = round(dims.reduce((s, d) => s + d.contribution, 0));

  // Hard caps are separate rules, not folded into the weighted sum, so a strong
  // candidate cannot buy their way past a gate.
  const appliedCaps: string[] = [];
  let composite = rawComposite;
  if (educationAsked && !educationAccepted) {
    const before = composite;
    composite = Math.min(composite, policy.caps.educationNotAccepted);
    // Only record the cap when it actually lowered the score; a failed gate is
    // already visible in `gates`.
    if (composite < before) {
      appliedCaps.push(
        `capped at ${policy.caps.educationNotAccepted} because no accepted education category`,
      );
    }
  }
  if (foodSectorP !== null) {
    const zone = threeZone(foodSectorP, policy).zone;
    if (zone === "low") {
      // Decisively absent: chop the composite. Near-coin-flip presence must not.
      const before = composite;
      composite = Math.min(composite, policy.caps.noFoodSector);
      if (composite < before) {
        appliedCaps.push(`capped at ${policy.caps.noFoodSector} because there is no experience in ${policy.sector.label}`);
      }
    } else if (zone === "mid") {
      // Uncertain: leave the composite alone but route to a human.
      reviewReasons.push(
        `${policy.sector.label} presence is uncertain (p=${round(foodSectorP, 3)}), so the sector cap was not applied`,
      );
    }
  }
  composite = round(clamp01(composite));

  // ---------- Priority (independent of the score, per the spec) ----------
  const rnd = answers.rnd_priority;
  const priority = {
    flagged: isNoul(rnd) ? rnd.noul >= 0.5 : false,
    probability: isNoul(rnd) ? round(rnd.noul) : 0,
    keywords: policy.priorityKeywords,
  };

  // ---------- Recommendation, derived in code ----------
  let recommendation: Recommendation =
    composite >= policy.thresholds.interview
      ? "INTERVIEW"
      : composite >= policy.thresholds.maybe
        ? "MAYBE"
        : "PASS";

  // A rejecting gate is disqualifying even when the capped composite still lands in
  // MAYBE territory, e.g. the education cap of 0.5 equals the MAYBE threshold. The
  // composite stays as computed for transparency; only the routing changes.
  for (const gate of policy.rejectingGates) {
    const failed =
      gate === "education"
        ? educationAsked && !educationAccepted
        : gate === "foodSector"
          ? !foodSectorPresent
          : gate === "stability"
            ? stabilityRedFlag
            : false;
    if (failed) {
      recommendation = "PASS";
      reviewReasons.push(`disqualifying gate failed: ${gate}`);
    }
  }

  // ---------- Evidence quality ----------
  // Only a decisive flag routes to a human. A p of 0.59 on "is this CV internally weak"
  // is not a finding, and treating it as one flagged almost every CV in a real folder.
  const eq = answers.evidence_quality_flag;
  if (isNoul(eq) && eq.noul >= policy.review.borderlineHigh) {
    reviewReasons.push(`model flagged weak or contradictory evidence (p=${round(eq.noul, 3)})`);
  } else if (isNoul(eq) && eq.noul > 0.5) {
    notes.push(`the model had some doubt about how readable this CV is (p=${round(eq.noul, 3)})`);
  }
  dims.filter((d) => d.unknown).forEach((d) => reviewReasons.push(`${d.label} is unknown`));

  // ---------- Promote a close call, but only on a close decision ----------
  //
  // Uncertainty matters where it changes the answer. If the score sits on one of the
  // lines, a field the model was unsure about is worth a person's minute; if the score is
  // nowhere near a line, the same uncertainty is just a note on the detail view.
  if (confidenceNotes.length) {
    const distances = [policy.thresholds.interview, policy.thresholds.maybe].map((t) =>
      Math.abs(composite - t),
    );
    const nearest = Math.min(...distances);
    if (nearest <= 0.05) {
      reviewReasons.push(
        `${confidenceNotes[0]} and the score sits on the line (${nearest.toFixed(3)} away), so a person should look`,
      );
      notes.push(...confidenceNotes.slice(1));
    } else {
      notes.push(...confidenceNotes);
    }
  }

  // Only weighted dimensions can be called a strength or a gap. A flag field that is
  // switched on for information must never read as a reason to hire or reject.
  const scored = dims.filter((d) => d.mode !== "flag");
  const strengths = scored
    .filter((d) => d.value >= 0.75)
    .sort((a, b) => b.weight - a.weight)
    .map((d) => `${d.label}: ${d.basis}`);
  const gaps = scored
    .filter((d) => d.value <= 0.25)
    .sort((a, b) => b.weight - a.weight)
    .map((d) => `${d.label}: ${d.basis}`);

  const lossRanked = [...scored].sort(
    (a, b) => b.weight * (1 - b.value) - a.weight * (1 - a.value),
  );
  const explanation =
    `Composite ${composite.toFixed(3)} for ${policy.roleTitle}. ` +
    `Biggest weighted losses: ` +
    lossRanked
      .slice(0, 3)
      .map((d) => `${d.label} (${d.contribution.toFixed(3)}/${d.weight.toFixed(2)})`)
      .join(", ") +
    `.` +
    (appliedCaps.length ? ` Caps applied: ${appliedCaps.join("; ")}.` : "") +
    (reviewReasons.length ? ` Needs review: ${reviewReasons.join("; ")}.` : "");

  return {
    policyId: policy.id,
    roleTitle: policy.roleTitle,
    candidate,
    composite,
    rawComposite,
    capped: appliedCaps.length > 0,
    appliedCaps,
    dimensions: dims,
    gates: { educationAccepted, foodSectorPresent, stabilityRedFlag },
    priority,
    recommendation,
    needsHumanReview: reviewReasons.length > 0,
    reviewReasons: [...new Set(reviewReasons)],
    notes: [...new Set(notes)],
    strengths,
    gaps,
    explanation,
    fields,
    awaitingRescan,
  };
}

/** "job_hopping" -> "job hopping", for text shown to a person. */
export function humaniseOption(option: string): string {
  return option.replace(/_/g, " ").replace(/^([a-z])/, (m) => m.toUpperCase());
}

export { DIM_LABELS };
