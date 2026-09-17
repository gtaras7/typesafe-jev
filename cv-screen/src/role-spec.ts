/**
 * The role definition as DATA.
 *
 * Everything policy-shaped lives here: weights, hard caps, partial-credit rules,
 * decision thresholds. None of it goes into the prompt, so changing a weight or a
 * threshold never requires re-running inference (the raw judgments are still valid).
 * Mirrors the criteria of the original qualification prompt 1:1.
 */

export type DimensionId =
  | "experience_years"
  | "education"
  | "food_sector"
  | "age_over_28"
  | "military"
  | "stability";

/** Named gates that can be rejecting. Only the listed ones force a PASS when failed. */
export type GateId = "education" | "foodSector" | "stability";

export interface RoleSpec {
  id: string;
  title: string;
  minExperienceYears: number;
  /** Accepted degree categories -> rubric description. Anything else fails the gate. */
  acceptedEducation: Record<string, string>;
  educationNoMatchKey: string;
  weights: Record<DimensionId, number>;
  /** Hard caps applied to the composite, from separate gate questions. */
  caps: { educationNotAccepted: number; noFoodSector: number };
  /** Score for a dimension the CV does not let us determine (existing partial-credit rule). */
  unknownCredit: number;
  stability: { maxEmployers: number; windowYears: number };
  priorityKeywords: string[];
  thresholds: { interview: number; maybe: number };
  review: { minConfidence: number; borderlineLow: number; borderlineHigh: number };
  /**
   * Gates that, when failed, force recommendation = "PASS" regardless of where the
   * capped composite lands. A list rather than a boolean so a role can decide which
   * gates are disqualifying and which are merely weighted penalties.
   */
  rejectingGates: GateId[];
}

export const FOOD_INDUSTRY_QA: RoleSpec = {
  id: "food-industry-qa-rnd",
  title: "Food industry (QA / R&D / production)",
  minExperienceYears: 3,

  acceptedEducation: {
    food_chemistry:
      "Chemistry with a food specialisation. Greek: Χημικός με κατεύθυνση Τροφίμων, Εφαρμοσμένη Χημεία (Τρόφιμα).",
    agronomy:
      "Agriculture / agronomy / agricultural science. Greek: Γεωπόνος, Αγρονόμος, Γεωπονική.",
    food_technology:
      "Food technology or food science and technology. Greek: Τεχνολόγος Τροφίμων, Τεχνολογία Τροφίμων, Επιστήμη Τροφίμων.",
  },
  educationNoMatchKey: "other_not_accepted",

  // The existing prompt's weights, unchanged.
  weights: {
    experience_years: 0.2,
    education: 0.2,
    food_sector: 0.2,
    age_over_28: 0.15,
    military: 0.1,
    stability: 0.15,
  },

  caps: { educationNotAccepted: 0.5, noFoodSector: 0.55 },

  // "ΑΓΝΩΣΤΟ" branches in the existing prompt: +0.10 / 0.20, +0.07 / 0.15, +0.05 / 0.10
  unknownCredit: 0.47,

  stability: { maxEmployers: 3, windowYears: 4 },

  priorityKeywords: ["RnD", "R&D", "Research and Development"],

  thresholds: { interview: 0.75, maybe: 0.5 },

  review: {
    minConfidence: 0.6,
    // A gate probability inside this band is too close to call: send it to a human.
    borderlineLow: 0.35,
    borderlineHigh: 0.65,
  },

  // A failed education gate is disqualifying even when the 0.5 cap lands exactly on
  // the MAYBE threshold. A missing food-sector background is deliberately NOT
  // rejecting: its 0.55 cap sits above MAYBE on purpose, since the wrong degree is
  // more fatal than a missing sector background.
  rejectingGates: ["education"],
};
