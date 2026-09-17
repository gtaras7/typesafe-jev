/**
 * Role presets: a starting policy the user can edit rather than a black box.
 *
 * The first preset is the food-industry role that was already verified against five
 * CVs, plus career progression switched on. `FOOD_INDUSTRY_POLICY` is kept free of
 * extra fields on purpose: it is the baseline the eval harness describes, and those
 * numbers must stay comparable.
 */

import { FOOD_INDUSTRY_QA } from "./role-spec.js";
import { BLANK_POLICY, normalisePolicy, roleSpecToPolicy, type ExtraField, type Policy } from "./policy.js";
import { libraryField } from "./fields.js";

/** The verified baseline: six dimensions, no extra fields. */
export const FOOD_INDUSTRY_POLICY: Policy = roleSpecToPolicy(FOOD_INDUSTRY_QA);

function withFields(base: Policy, ids: string[], overrides: Partial<Policy> = {}): Policy {
  // Library entries ship switched off, so a preset has to switch its own on.
  const fields = ids
    .map((id) => libraryField(id))
    .filter((f): f is ExtraField => Boolean(f))
    .map((f) => ({ ...f, enabled: true }));
  return normalisePolicy({
    ...base,
    ...overrides,
    extraFields: [...(base.extraFields ?? []), ...fields],
  });
}

export interface Preset {
  id: string;
  label: string;
  help: string;
  policy: Policy;
}

export const PRESETS: Preset[] = [
  {
    id: "food-industry-qa",
    label: "Food industry (QA / R&D / production)",
    help: "Chemistry, agronomy or food technology degree, 3+ years, food-sector background, over 28, military service, stable employers. Career progression is switched on.",
    policy: withFields(FOOD_INDUSTRY_POLICY, ["career_progression"]),
  },
  {
    id: "software-engineer",
    label: "Software engineer",
    help: "Reads what the candidate personally built, how hard it was and how much they owned, plus career shape and ownership. No age, military or sector rules.",
    policy: withFields(
      {
        ...BLANK_POLICY,
        id: "software-engineer",
        roleTitle: "Software engineer",
        minExperienceYears: 3,
        weights: {
          experience_years: 0.15,
          education: 0,
          food_sector: 0,
          age_over_28: 0,
          military: 0,
          stability: 0.1,
        },
        priorityKeywords: [],
        rejectingGates: [],
      },
      ["technical_depth", "ownership_leadership", "career_progression", "motivation_fit"],
    ),
  },
  {
    id: "any-role",
    label: "Any role, my own rules",
    help: "A nearly empty policy: experience and stability only. Switch on the fields you care about and set the weights yourself.",
    policy: withFields(
      { ...BLANK_POLICY, id: "any-role", roleTitle: "My role" },
      ["career_progression"],
    ),
  },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** What the app starts with when no policy has been saved yet. */
export function defaultPolicy(): Policy {
  return structuredClone(PRESETS[0]!.policy);
}

export function presetList() {
  return PRESETS.map(({ id, label, help }) => ({ id, label, help }));
}
