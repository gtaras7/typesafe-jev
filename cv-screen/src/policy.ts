/**
 * The Policy: the single editable source of truth for what we ask Jev and how the
 * answers turn into a decision.
 *
 * Two things changed from `role-spec.ts`:
 *
 *  1. Extra fields. The six core dimensions are fixed and validated, but a recruiter
 *     can switch on more questions (career progression, hands-on depth, and anything
 *     they define themselves) without touching this file.
 *  2. Weights are declared in absolute terms and normalised by their own sum in
 *     `compose.ts`. Adding a field worth 0.10 therefore never silently rescales the
 *     existing ones, which a hand-maintained "weights sum to 1" would have done.
 *
 * Nothing here is a prompt. Every question is built from these fields in
 * `questions.ts`, and every number the user sees is computed in `compose.ts`. That
 * separation is what lets weights, caps and thresholds change with no new inference:
 * the stored judgments stay valid.
 */

import type { RoleSpec } from "./role-spec.js";

export type FieldKind = "noul" | "choice" | "score";

/** What a field does to the decision. */
export type FieldMode =
  /** counts in the weighted match score */
  | "weight"
  /** a column and a possible review trigger, never changes the score */
  | "flag";

export interface ExtraField {
  id: string;
  label: string;
  /** One line of plain English shown next to the switch in the UI. */
  help?: string;
  kind: FieldKind;
  mode: FieldMode;
  weight: number;
  instructions: string;
  /**
   * choice: option key -> rubric. score: ordered levels, either plain strings or
   * `{ what, examples }` objects (the form the TypeSafe docs recommend when the model
   * keeps landing between two levels). noul: not needed.
   */
  criteria?: Array<string | { what: string; examples?: string[] }> | Record<string, string>;
  /** noul only: what yes and no mean. */
  noulCriteria?: { true: string; false: string };
  /**
   * noul only: which way the credit runs. Default is "yes is good", so a yes answer
   * contributes its probability. Use "yes is bad" for a field where a yes is a
   * concern (an unexplained gap, for example).
   */
  noulPolarity?: "yes_is_good" | "yes_is_bad";
  /** choice only: option key -> credit 0..1. Missing keys fall back to unknownCredit. */
  choiceValues?: Record<string, number>;
  /** Route to a human when the answer lands here. */
  reviewWhen?: {
    /** choice option keys that always need a person to look */
    options?: string[];
    /** noul: flag a review when the probability is at or above this */
    noulAbove?: number;
  };
  /** Shown in the UI as a caveat (for example: expects more disagreement). */
  note?: string;
  enabled: boolean;
}

export interface Policy {
  id: string;
  roleTitle: string;
  minExperienceYears: number;
  /** Accepted degree categories. Anything else fails the education gate. */
  acceptedEducation: Array<{ key: string; label: string; match: string }>;
  educationNoMatchKey: string;
  /** Rubric for "none of the accepted categories". Optional: a generic wording is used otherwise. */
  educationNoMatchText?: string;
  /** Optional override of the education question's instruction line. */
  educationInstructions?: string;
  /**
   * Optional override of the experience Score levels. When set, replaces the auto-generated
   * 4-level template so seniority presets can tailor the bar (e.g. "internship counts" for
   * entry-level vs. "system ownership expected" for senior).
   */
  experienceLevels?: Array<string | { what: string; examples?: string[] }>;
  /** Optional override of the experience question's instruction line. */
  experienceInstructions?: string;
  /** Core dimension weights, by DimensionId. */
  weights: Record<string, number>;
  caps: { educationNotAccepted: number; noFoodSector: number };
  /** Credit for a dimension the CV does not let us determine. */
  unknownCredit: number;
  stability: { maxEmployers: number; windowYears: number };
  priorityKeywords: string[];
  thresholds: { interview: number; maybe: number };
  review: { minConfidence: number; borderlineLow: number; borderlineHigh: number };
  rejectingGates: string[];
  age: { enabled: boolean; minAge: number };
  military: { enabled: boolean; fullCreditIfNotApplicable: boolean; question: string };
  sector: {
    enabled: boolean;
    /** Read into the generated questions, so it must read naturally mid-sentence: "the food sector". */
    label: string;
    question: string;
    /** Optional override of the sector depth levels, for a role with a hand-written rubric. */
    depthLevels?: string[];
  };
  extraFields: ExtraField[];
}

export const CORE_DIMENSIONS = [
  "experience_years",
  "education",
  "food_sector",
  "age_over_28",
  "military",
  "stability",
] as const;

export const DEFAULT_REVIEW = { minConfidence: 0.6, borderlineLow: 0.35, borderlineHigh: 0.65 };

/** A neutral starting point for a role the user defines from scratch. */
export const BLANK_POLICY: Policy = {
  id: "custom-role",
  roleTitle: "My role",
  minExperienceYears: 2,
  acceptedEducation: [],
  educationNoMatchKey: "other_not_accepted",
  weights: {
    experience_years: 0.25,
    // Zero, not a small number: a blank role has no degree requirement, and a weight without
    // accepted degrees would fail every candidate on the education gate.
    education: 0,
    food_sector: 0,
    age_over_28: 0,
    military: 0,
    stability: 0.15,
  },
  caps: { educationNotAccepted: 0.5, noFoodSector: 0.55 },
  unknownCredit: 0.47,
  stability: { maxEmployers: 3, windowYears: 4 },
  priorityKeywords: [],
  thresholds: { interview: 0.75, maybe: 0.5 },
  review: { ...DEFAULT_REVIEW },
  rejectingGates: [],
  age: { enabled: false, minAge: 28 },
  military: { enabled: false, fullCreditIfNotApplicable: true, question: "" },
  sector: {
    enabled: false,
    // Read into the generated questions, so it must read naturally mid-sentence after "in":
    // "clearly in the required sector". A role that knows its sector replaces this with its own
    // phrase ("the food sector", "frontend development with React or React Native").
    label: "the required sector",
    question: "",
  },
  extraFields: [],
};

/**
 * The food-industry role, carried over 1:1 from `role-spec.ts` so the earlier
 * verification (the eval harness and the graded food-industry runs) still describes
 * this policy exactly. `roleSpecToPolicy` is the only bridge, and
 * `policy.test.ts` asserts the round trip keeps every number identical.
 */
export function roleSpecToPolicy(role: RoleSpec): Policy {
  return {
    id: role.id,
    roleTitle: role.title,
    minExperienceYears: role.minExperienceYears,
    acceptedEducation: Object.entries(role.acceptedEducation).map(([key, match]) => ({
      key,
      label: key.replace(/_/g, " "),
      match,
    })),
    educationNoMatchKey: role.educationNoMatchKey,
    educationInstructions:
      "Which best describes the candidate's highest relevant degree? The role requires one of the accepted categories listed in the state. Degrees that are merely adjacent, such as general biology, general chemistry without a food specialisation, or an unrelated field, do not qualify.",
    educationNoMatchText:
      "No degree from the accepted categories, or the degree is not stated.",
    weights: { ...role.weights },
    caps: { ...role.caps },
    unknownCredit: role.unknownCredit,
    stability: { ...role.stability },
    priorityKeywords: [...role.priorityKeywords],
    thresholds: { ...role.thresholds },
    review: { ...role.review },
    rejectingGates: [...role.rejectingGates],
    age: { enabled: true, minAge: 28 },
    military: {
      enabled: true,
      fullCreditIfNotApplicable: true,
      question:
        "What is this candidate's military service status? Evaluate the CV text as a whole, taking the candidate's apparent gender into account where the CV indicates it.",
    },
    sector: {
      enabled: true,
      label: "the food sector",
      question:
        "Has this candidate ever worked for an organisation that operates in the food sector, such as food manufacturing, food quality, food R&D, food safety, beverages, or agricultural production? Judge from employer names and job titles.",
      depthLevels: [
        { what: "No food-sector exposure at all", examples: ["IT support, marketing, finance"] },
        {
          what: "Adjacent or indirect exposure, such as agriculture, retail food, or hospitality",
        },
        {
          what:
            "Direct food-sector role, such as quality control, production, or regulatory work in a food company",
        },
        {
          what:
            "Senior or specialist food-sector role, such as R&D technologist, HACCP coordinator, or head of quality",
          examples: ["Senior R&D Technologist at a dairy manufacturer"],
        },
      ] as unknown as string[],
    },
    extraFields: [],
  };
}

/**
 * Accept either a Policy or a legacy RoleSpec and return a Policy. Every entry point
 * takes `Policy | RoleSpec` so the existing tests, CLI and eval
 * harness keep working unchanged while the new UI speaks Policy throughout.
 */
export function asPolicy(input: Policy | RoleSpec): Policy {
  if (isPolicy(input)) return input;
  if (input && typeof input === "object" && "weights" in (input as object)) {
    return roleSpecToPolicy(input as RoleSpec);
  }
  // Better a loud failure than a silently empty policy: reaching here means a stored
  // blob or a hand-edited file is not a policy at all.
  throw new Error("not a policy or a role spec");
}

export function isPolicy(x: unknown): x is Policy {
  return Boolean(x && typeof x === "object" && "roleTitle" in (x as object));
}

/** Ids of every weighted dimension the policy enables, core ones first. */
export function weightedDimensionIds(policy: Policy): string[] {
  const core = CORE_DIMENSIONS.filter((id) => (policy.weights[id] ?? 0) > 0);
  const extras = policy.extraFields
    .filter((f) => f.enabled && f.mode === "weight" && f.weight > 0)
    .map((f) => f.id);
  return [...core, ...extras];
}

/** Sum of the weights that actually count, the normaliser for the match score. */
export function weightTotal(policy: Policy): number {
  const core = CORE_DIMENSIONS.reduce((s, id) => s + Math.max(0, policy.weights[id] ?? 0), 0);
  const extras = policy.extraFields
    .filter((f) => f.enabled && f.mode === "weight")
    .reduce((s, f) => s + Math.max(0, f.weight), 0);
  return core + extras;
}

export function allFieldIds(policy: Policy): string[] {
  return [...weightedDimensionIds(policy), ...flagFieldIds(policy)];
}

/** Enabled fields that are shown but never scored. */
export function flagFieldIds(policy: Policy): string[] {
  return policy.extraFields.filter((f) => f.enabled && f.mode === "flag").map((f) => f.id);
}

/** Question id used for a core dimension in the question map. */
export const CORE_QUESTIONS: Record<string, string[]> = {
  experience_years: ["experience_determinable", "experience_level"],
  education: ["education"],
  food_sector: ["food_sector_present", "food_sector_depth"],
  age_over_28: ["age_evidence"],
  military: ["military_status"],
  stability: ["stability_red_flag"],
};

/** Always asked, never part of the score. */
export const SIDE_QUESTIONS = ["rnd_priority", "evidence_quality_flag"];

/**
 * The authoritative list of question ids a policy asks lives in `questions.ts`
 * (`policyQuestionIds`), generated from `buildQuestions` itself so the two can never
 * drift: a policy that asks something is exactly the policy whose questions exist.
 */

/* ------------------------------------------------------------------ validation */

export interface PolicyIssue {
  path: string;
  message: string;
}

/**
 * Reject a policy that would produce a meaningless request or a misleading score.
 * The UI shows these next to the offending control, so the messages are written for
 * a person, not a stack trace.
 */
export function validatePolicy(p: Policy): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });

  if (!p.roleTitle?.trim()) push("roleTitle", "Give the role a name.");
  if (!Number.isFinite(p.minExperienceYears) || p.minExperienceYears < 0)
    push("minExperienceYears", "Minimum experience must be zero or more years.");

  for (const [id, w] of Object.entries(p.weights ?? {})) {
    if (!Number.isFinite(w) || w < 0) push(`weights.${id}`, "A weight cannot be negative.");
    if (w > 1) push(`weights.${id}`, "A weight above 1 has no meaning.");
  }

  if (weightTotal(p) <= 0)
    push("weights", "Switch on at least one thing that matters, or nothing can be scored.");

  if (p.thresholds.maybe > p.thresholds.interview)
    push("thresholds", "The Maybe line cannot sit above the Interview line.");

  const dup = new Set<string>();
  for (const f of p.extraFields) {
    if (dup.has(f.id)) push(`extraFields.${f.id}`, "Two fields share the same internal id.");
    dup.add(f.id);
    if (!f.label?.trim()) push(`extraFields.${f.id}`, "Give the field a name.");
    if (!f.instructions?.trim())
      push(`extraFields.${f.id}`, "Write the instruction the model should follow.");
    if (f.kind === "score" && (!Array.isArray(f.criteria) || f.criteria.length < 2))
      push(`extraFields.${f.id}`, "A rating scale needs at least two levels.");
    const options = Array.isArray(f.criteria) ? f.criteria : Object.keys(f.criteria ?? {});
    if (f.kind === "choice" && options.length < 2)
      push(`extraFields.${f.id}`, "An options question needs at least two options.");
    if (f.mode === "weight" && (!Number.isFinite(f.weight) || f.weight < 0 || f.weight > 1))
      push(`extraFields.${f.id}`, "Importance must be between 0 and 1.");
    if (f.enabled && (p.weights[f.id] ?? undefined) !== undefined && f.mode === "weight")
      push(`extraFields.${f.id}`, "This id collides with a built-in dimension.");
  }

  if (!p.age.enabled && (p.weights.age_over_28 ?? 0) > 0)
    push("age", "The age rule is switched off, so its weight does nothing. Set it to 0.");
  if (!p.military.enabled && (p.weights.military ?? 0) > 0)
    push("military", "The military rule is switched off, so its weight does nothing. Set it to 0.");
  if (!p.sector.enabled && (p.weights.food_sector ?? 0) > 0)
    push("sector", "The sector question is switched off, so its weight does nothing. Set it to 0.");
  // A weight with no accepted degrees cannot be judged in the candidate's favour: every CV would
  // land on the no-match option and the education cap would hit everybody. Refuse it up front.
  if ((p.weights.education ?? 0) > 0 && !p.acceptedEducation.length)
    push(
      "education",
      "The education weight needs accepted degrees to judge against, or every candidate fails it. Add a degree, or set the weight to 0.",
    );

  return issues;
}

/** Fill in anything a caller left out, so stored policies stay readable. */
export function normalisePolicy(input: Partial<Policy>): Policy {
  const p: Policy = {
    ...BLANK_POLICY,
    ...input,
    weights: { ...BLANK_POLICY.weights, ...(input.weights ?? {}) },
    caps: { ...BLANK_POLICY.caps, ...(input.caps ?? {}) },
    stability: { ...BLANK_POLICY.stability, ...(input.stability ?? {}) },
    thresholds: { ...BLANK_POLICY.thresholds, ...(input.thresholds ?? {}) },
    review: { ...BLANK_POLICY.review, ...(input.review ?? {}) },
    age: { ...BLANK_POLICY.age, ...(input.age ?? {}) },
    military: { ...BLANK_POLICY.military, ...(input.military ?? {}) },
    sector: { ...BLANK_POLICY.sector, ...(input.sector ?? {}) },
    acceptedEducation: input.acceptedEducation ?? [],
    priorityKeywords: input.priorityKeywords ?? [],
    rejectingGates: input.rejectingGates ?? [],
    extraFields: (input.extraFields ?? []).map((f) => ({
      ...f,
      criteria: f.criteria ?? (f.kind === "score" ? [] : {}),
      mode: f.mode ?? "weight",
      weight: Number.isFinite(f.weight) ? f.weight : 0.1,
      enabled: f.enabled ?? true,
    })),
  };
  return p;
}
