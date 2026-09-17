/**
 * Build the question map for a policy.
 *
 * Design rules taken from the TypeSafe skill, and reinforced by what the eval harness
 * measured:
 *  - the judgment goes in `instructions`, the possible answers in `criteria`
 *  - one narrow, coherent judgment per question
 *  - every closed set includes a no-match / not-stated option
 *  - code owns arithmetic and counting, so we ask for judgments, never for sums
 *  - questions that only matter on one branch are asked anyway (speculative fan-out);
 *    code consumes the branch it needs
 *
 * The six core dimensions are the measured, verified set. Anything else is an extra
 * field from the library or a field the user defined, and is generated generically.
 *
 * Wording for the core questions is deliberately unchanged from the original
 * single-role version. The eval labels were written against these exact questions,
 * so their phrasing stays put.
 */

import type { Question, Questions } from "./types.js";
import type { ExtraField, Policy } from "./policy.js";
import { asPolicy } from "./policy.js";
import type { RoleSpec } from "./role-spec.js";

/**
 * Placeholder for the date the age judgment is made against.
 *
 * A literal date must never be baked into the question text, or the age question goes
 * stale: a request built in September would still tell the model it is September a year
 * later. The question map carries this token instead, and it is replaced with the run
 * date when the request is built, so every judgment is made against today.
 */
export const TODAY_TOKEN = "__TODAY__";

/**
 * Every question id this policy asks. Generated from `buildQuestions` so the two can
 * never disagree: recompose uses it to notice that a stored CV has no answer for a
 * question the current policy wants.
 */
export function policyQuestionIds(policyOrRole: Policy | RoleSpec): string[] {
  return Object.keys(buildQuestions(policyOrRole, TODAY_TOKEN));
}

/** The extra field behind a question id, if it is one. */
export function fieldForQuestion(policy: Policy, id: string): ExtraField | undefined {
  return policy.extraFields.find((f) => f.id === id);
}

export function fieldQuestion(field: ExtraField): Question {
  switch (field.kind) {
    case "noul":
      return {
        type: "noul",
        instructions: field.instructions,
        criteria: field.noulCriteria,
      };
    case "choice":
      return {
        type: "choice",
        instructions: field.instructions,
        criteria: Array.isArray(field.criteria)
          ? Object.fromEntries(field.criteria.map((c, i) => [String(i), levelText(c)]))
          : (field.criteria ?? {}),
      };
    case "score":
      return {
        type: "score",
        instructions: field.instructions,
        criteria: Array.isArray(field.criteria) ? field.criteria : Object.values(field.criteria ?? {}),
      };
  }
}

/** A level as text, whether it was written as a string or as a structured object. */
export function levelText(level: string | { what: string; examples?: string[] }): string {
  return typeof level === "string" ? level : level.what;
}

export function buildQuestions(policyOrRole: Policy | RoleSpec, today: string): Questions {
  const policy = asPolicy(policyOrRole);
  const q: Questions = {};
  const sectorLabel = policy.sector.label || "the required sector";

  // --- Dimension 1: experience. Presence is split out because "unknown" has its
  // own partial-credit rule in the spec, and a Score cannot express "no evidence".
  if ((policy.weights.experience_years ?? 0) > 0) {
    const bar = policy.minExperienceYears;
    q.experience_determinable = {
      type: "noul",
      instructions:
        "Does the CV state professional work experience with enough detail (role and dates, or role and an explicit duration) to measure total years of employment?",
      criteria: {
        true: "Dated roles, or explicit statements like '8 years of experience'.",
        false: "No work history at all, or roles listed with no dates or durations whatsoever.",
      },
    };
    q.experience_level = {
      type: "score",
      instructions: `How many years of professional work experience does this candidate have, counting all positions and treating concurrent freelance or contract work as a single continuous run? Compare against the bar of ${bar} years.`,
      criteria: [
        {
          what: "Under 1 year of professional experience",
          examples: ["Internships only", "One role under a year"],
        },
        { what: "1 to under 2 years of professional experience" },
        { what: `2 to under ${bar} years, short of the bar` },
        {
          what: `${bar} years or more of professional experience`,
          examples: ["Roles spanning 2015 to today", "8+ years in the industry"],
        },
      ],
    };
  }

  // --- Dimension 2: education. This question is also the gate, so the closed set
  // must contain an explicit no-match option.
  //
  // Only asked when the policy actually lists accepted categories. With an empty list every CV
  // would match the no-match option by definition, the education gate would fail for everybody
  // and its cap would flatten the whole shortlist, which is a silent and total loss of signal.
  if (policy.acceptedEducation.length) {
    const criteria: Record<string, string | null> = {};
    for (const e of policy.acceptedEducation) criteria[e.key] = e.match || e.label;
    criteria[policy.educationNoMatchKey] =
      policy.educationNoMatchText ??
      "No degree from the accepted categories, or the degree is not stated.";
    q.education = {
      type: "choice",
      instructions:
        policy.educationInstructions ??
        "Which best describes the candidate's highest relevant degree? The role requires one of the accepted categories listed in the state. Degrees that are merely adjacent to them, or in an unrelated field, do not qualify.",
      criteria,
    };
  }

  // --- Dimension 3: sector presence (the gate) and depth (the weighted signal).
  if (policy.sector.enabled) {
    q.food_sector_present = {
      type: "noul",
      instructions: policy.sector.question,
      criteria: {
        true: `At least one employer or role is clearly in ${sectorLabel}.`,
        false: `Every employer and role is outside ${sectorLabel}, or no employers are named.`,
      },
    };
    q.food_sector_depth = {
      type: "score",
      instructions: `How much of this candidate's career has been spent in ${sectorLabel}, and how central was their role to it?`,
      criteria:
        policy.sector.depthLevels ??
        [
          `No exposure to ${sectorLabel} at all`,
          "Adjacent or indirect exposure only",
          `Direct role in ${sectorLabel}`,
          `Senior or specialist role in ${sectorLabel}`,
        ],
    };
  }

  // --- Dimension 4: age. Code owns the rule; the model reports which kind of
  // evidence exists and then the policy is applied mechanically.
  if (policy.age.enabled) {
    q.age_evidence = {
      type: "choice",
      instructions: `The role requires the candidate to be over ${policy.age.minAge} years of age. Today's date is ${today}, given in the state. Which kind of age evidence does the CV contain?`,
      criteria: {
        over_28_stated: `A birth date, explicit age, or other direct statement placing the candidate above ${policy.age.minAge} today.`,
        under_28_stated: `A birth date, explicit age, or other direct statement placing the candidate at or below ${policy.age.minAge} today.`,
        inferable_indirectly:
          "No direct statement, but graduation year, military service year, or career start year makes a rough age range plausible.",
        not_stated: "Nothing in the CV supports any estimate of age.",
      },
    };
  }

  // --- Dimension 5: military service. One closed set covers the gender branch too,
  // so the "only for men" rule is expressed without a second question.
  if (policy.military.enabled) {
    q.military_status = {
      type: "choice",
      instructions:
        policy.military.question ||
        "What is this candidate's military service status? Evaluate the CV text as a whole, taking the candidate's apparent gender into account where the CV indicates it.",
      criteria: {
        completed: "Military service is stated as completed or fulfilled.",
        pending_or_not_completed:
          "Military service is stated or clearly implied as not yet completed, deferred, or outstanding.",
        exempted: "An exemption, discharge on medical grounds, or a documented waiver is stated.",
        not_applicable_female:
          "The candidate is female, or the CV states military service does not apply.",
        not_stated: "The CV gives no indication of military service status.",
      },
    };
  }

  // --- Dimension 6: stability. Counting employers is code's job, but this CV text
  // is unstructured, so we ask the bounded judgment and code inverts it.
  if ((policy.weights.stability ?? 0) > 0) {
    const { maxEmployers, windowYears } = policy.stability;
    q.stability_red_flag = {
      type: "noul",
      instructions: `Has this candidate worked for more than ${maxEmployers} different employers during the last ${windowYears} years? Count distinct employers, not roles. Consecutive freelance or contract engagements count as one employer.`,
      criteria: {
        true: `More than ${maxEmployers} distinct employers inside the window.`,
        false: `For example ${maxEmployers} or fewer distinct employers, or a single long-running role, inside the window.`,
      },
    };
  }

  // --- Independent flag. Deliberately NOT part of the composite.
  if (policy.priorityKeywords.length) {
    q.rnd_priority = {
      type: "noul",
      instructions: `Does the CV contain any of these keywords or a clear equivalent referring to research and development work: ${policy.priorityKeywords.join(", ")}?`,
      criteria: {
        true: "One of those strings, or an unambiguous research and development role, appears.",
        false: "No sign of research and development anywhere in the CV.",
      },
    };
  }

  // Drives human review. Deliberately scoped to the CV as a document: an earlier
  // wording said "or a core criterion with no evidence at all", which made Jev answer
  // yes for every candidate who simply did not match the role, duplicating the score
  // and the gates. Measured at 2/5 agreement before the narrowing.
  q.evidence_quality_flag = {
    type: "noul",
    instructions:
      "Judge only the internal quality of this CV as a document, and ignore whether the candidate matches the role. Is the CV internally inconsistent, or so incomplete that its facts cannot be read reliably, such that a recruiter should read it personally before trusting any automated assessment of it?",
    criteria: {
      true: "Contradictory dates or roles, missing or unusable dates throughout, or a claim that contradicts another part of the same CV.",
      false:
        "Internally consistent and readable. The candidate may still be a poor match for the role, or have no experience in the sector, but the CV itself presents its facts coherently.",
    },
  };

  // --- Extra fields, in the order the user arranged them.
  for (const field of policy.extraFields) {
    if (!field.enabled) continue;
    if (field.id in q) continue; // never silently shadow a core question
    if (field.kind === "noul") {
      const f: ExtraField = {
        ...field,
        noulCriteria: field.noulCriteria ?? {
          true: field.criteria && !Array.isArray(field.criteria) ? "Yes." : "The condition holds.",
          false: "The condition does not hold, or the CV does not say.",
        },
      };
      q[field.id] = fieldQuestion(f);
      continue;
    }
    // A field with nothing to judge by cannot be asked: an empty scale would make the
    // model invent levels, which is exactly the failure mode this project avoids.
    if (field.kind === "score" && (!Array.isArray(field.criteria) || field.criteria.length < 2)) {
      continue;
    }
    if (field.kind === "choice") {
      const opts = Array.isArray(field.criteria) ? field.criteria : Object.keys(field.criteria ?? {});
      if (opts.length < 2) continue;
    }
    q[field.id] = fieldQuestion(field);
  }

  return q;
}
