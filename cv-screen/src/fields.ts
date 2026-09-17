/**
 * The field library: questions a recruiter can switch on without writing a prompt.
 *
 * Every entry follows the same rules the measured core questions follow, because the
 * eval harness found that breaking them is what makes a judgment unreliable:
 *
 *  - one narrow, coherent judgment per question
 *  - concrete, self-standing levels, no arithmetic (counting is code's job)
 *  - a way out when the CV does not say (`unclear`, `not_stated`) rather than a guess
 *  - "when torn, pick the lower" on ordered scales, so optimism is not the default
 *
 * `career_progression` and `technical_depth` come from the user's TypeSafe demo notes.
 */

import type { ExtraField } from "./policy.js";

export interface LibraryEntry extends ExtraField {
  /** Plain-language summary shown on the card in Settings. */
  help: string;
  /** Where this pattern came from, for the curious. */
  source?: string;
}

export const FIELD_LIBRARY: LibraryEntry[] = [
  {
    id: "career_progression",
    label: "Career progression",
    help: "Reads the shape of the whole career: growing, sideways, jumping, or too unclear to tell.",
    source: "The career progression pattern shown in the TypeSafe demo.",
    kind: "choice",
    mode: "weight",
    weight: 0.1,
    instructions:
      "How has this candidate's career moved over time? Judge the shape of the progression from the job titles, employers and dates, not the length of the CV. Ignore gaps that are explained by study, parental leave or military service, and ignore a single short stay after a long one. When the shape is genuinely ambiguous, choose unclear rather than guessing.",
    criteria: {
      steady_growth:
        "Responsibility clearly grows over time, either at one employer or with each move being a step up. Titles, scope or ownership increase.",
      lateral_moves:
        "Moves between roles of similar level and scope, with no clear upward step and no pattern of short stays.",
      job_hopping:
        "Three or more stays of roughly under eighteen months each, with no stated reason such as a fixed term contract, relocation or study.",
      unclear:
        "The dates, roles or employers are too sparse or too inconsistent to see a shape at all.",
    },
    choiceValues: { steady_growth: 1, lateral_moves: 0.65, job_hopping: 0.25 },
    reviewWhen: { options: ["unclear"] },
    enabled: false,
  },
  {
    id: "technical_depth",
    label: "Hands-on depth",
    help: "How much the candidate personally built, how hard it was, and how much they owned.",
    source: "Written for this project, at the project author's request.",
    kind: "score",
    mode: "weight",
    weight: 0.15,
    instructions:
      "Rate hands-on engineering depth using the experience and project bullets: what the candidate personally built, how complex it was, and how much they owned. Ignore skills lists, keywords, titles and company names. Score the depth the CV shows, not the years worked. When torn between two levels, pick the lower.",
    // Structured levels rather than bare strings: the TypeSafe docs report that giving
    // each level a description plus a few real-looking examples raises answer confidence
    // when the model keeps landing between two neighbouring levels.
    criteria: [
      {
        what: "No role or project where the candidate wrote code.",
        examples: ["A finance CV listing spreadsheets and SAP", "A manager who only describes other people's work"],
      },
      {
        what: "Code appears only as coursework, a bootcamp or a tutorial exercise.",
        examples: ["A university project and a cloned tutorial app", "A bootcamp capstone nobody uses"],
      },
      {
        what: "Small scoped work inside someone else's design, such as bug fixes, small features, tests or scripts.",
        examples: ["Fixed bugs in a service someone else designed", "Added tests and small features to a team codebase"],
      },
      {
        what: "Owns features end to end, from design through shipping and keeping them running.",
        examples: ["Built and shipped a feature customers use", "Owned an API from design through on-call"],
      },
      {
        what: "Owns a whole system or service and makes its architectural decisions.",
        examples: ["Designed and ran the platform a whole team builds on", "Chose the architecture and answered for its reliability"],
      },
      {
        what: "Deep specialist with real breadth, such as hard production problems solved across more than one area.",
        examples: ["Rebuilt a system under load and fixed its performance across layers", "Known for depth in one area and real work in two others"],
      },
    ],
    enabled: false,
  },
  {
    id: "ownership_leadership",
    label: "Ownership and leadership",
    help: "Whether other people's work depended on this candidate, and how much.",
    kind: "score",
    mode: "weight",
    weight: 0.08,
    instructions:
      "How far does this candidate's responsibility extend beyond their own work? Judge from what they were accountable for, not from a title. When torn between two levels, pick the lower.",
    criteria: [
      "No evidence of responsibility beyond their own tasks.",
      "Helps colleagues informally, reviews other people's work or explains things to them.",
      "Owns a small project or workstream, or formally mentors one person.",
      "Leads a team or a workstream that other people's work depends on, with responsibility for outcomes.",
      "Leads several teams, or sets direction for a whole function or discipline.",
    ],
    enabled: false,
  },
  {
    id: "communication",
    label: "Communication",
    help: "Written and spoken work aimed at people outside the candidate's own team.",
    kind: "score",
    mode: "weight",
    weight: 0.05,
    instructions:
      "How much of this candidate's work is aimed at people outside their own team? Judge from what the CV says they produced or did, and ignore any self-description like 'excellent communicator'.",
    criteria: [
      "No evidence of written or spoken work outside their own immediate team.",
      "Writes internal notes or documentation for their own team.",
      "Writes material other teams use, presents to a group, or trains others.",
      "Writes for people outside the company, or represents it in front of clients, regulators or the public.",
    ],
    enabled: false,
  },
  {
    id: "motivation_fit",
    label: "Direction of the CV",
    help: "Whether the CV points at this kind of work, sideways into it, or somewhere else.",
    kind: "choice",
    mode: "weight",
    weight: 0.05,
    instructions:
      "Setting aside whether the candidate is good enough, does the direction of this CV point at the work being hired for? Judge the trajectory, not the quality. Ignore any stated wish to work here unless the history supports it.",
    criteria: {
      clearly_aligned:
        "The history points at this kind of work, and this role is a natural next step in it.",
      adjacent:
        "Transferable experience, but this role is a change of direction rather than a continuation.",
      different_direction:
        "The history points at different work, and this role would be a fresh start.",
      unclear: "Too little in the CV to tell what the candidate is aiming at.",
    },
    choiceValues: { clearly_aligned: 1, adjacent: 0.6, different_direction: 0.2 },
    reviewWhen: { options: ["unclear"] },
    enabled: false,
  },
  {
    id: "english_level",
    label: "English level",
    help: "Working level of English, from how the CV is written and where they have worked.",
    kind: "choice",
    mode: "weight",
    weight: 0.05,
    instructions:
      "How strong is this candidate's English for work purposes? Judge from how the CV itself is written, any stated level or test score, and whether they have worked in English.",
    criteria: {
      native_or_bilingual: "English is a first language, or the CV is written natively.",
      full_professional: "Stated C1 or C2, or a career carried out in English.",
      professional_working:
        "Stated B2, or a role with clear English use, with noticeable mistakes in the CV text.",
      limited: "Stated A2 or B1, or the CV is clearly written with a translator or template.",
      not_stated: "The CV gives no usable signal about English.",
    },
    choiceValues: {
      native_or_bilingual: 1,
      full_professional: 1,
      professional_working: 0.7,
      limited: 0.3,
    },
    reviewWhen: { options: ["not_stated"] },
    enabled: false,
  },
  {
    id: "relevant_certification",
    label: "Relevant certification",
    help: "A completed licence or qualification that matters for this kind of work.",
    kind: "noul",
    mode: "weight",
    weight: 0.04,
    instructions:
      "Does the CV show a completed professional certification, licence or vocational qualification that is directly relevant to this kind of role? Count only completed qualifications, not courses attended, and ignore school and university degrees.",
    noulCriteria: {
      true: "At least one completed, directly relevant certification or licence is named.",
      false: "None is named, or the only qualifications are degrees or attended courses.",
    },
    enabled: false,
  },
  {
    id: "employment_gaps",
    label: "Unexplained gaps",
    help: "Flags a long unexplained stretch in the timeline for a person to look at. Never scored.",
    kind: "noul",
    mode: "flag",
    weight: 0,
    noulPolarity: "yes_is_bad",
    note: "Asking a decision model to do date arithmetic is the least reliable thing we ask of it. Keep this as a flag for a human, never as part of the score.",
    instructions:
      "Looking only at the last ten years, is there a stretch of roughly a year or more with no paid role, study or stated reason in the timeline? Judge whether the CV leaves a long stretch unexplained, and answer yes only when the timeline is clear enough to see the gap.",
    noulCriteria: {
      true: "A clear stretch of about a year or more is left unexplained.",
      false: "No such stretch, or the timeline is too unclear to judge one way or the other.",
    },
    reviewWhen: { noulAbove: 0.65 },
    enabled: false,
  },
];

export const LIBRARY_BY_ID: Record<string, LibraryEntry> = Object.fromEntries(
  FIELD_LIBRARY.map((f) => [f.id, f]),
);

/** A fresh copy, so a caller can edit it without mutating the library. */
export function libraryField(id: string): ExtraField | undefined {
  const found = LIBRARY_BY_ID[id];
  return found ? structuredClone(found) : undefined;
}

/** Enough for the validator and for inference: an instruction plus the levels its kind needs. */
function hasOwnJudgment(f: ExtraField): boolean {
  if (!f.instructions?.trim()) return false;
  if (f.kind === "score") return Array.isArray(f.criteria) && f.criteria.length >= 2;
  if (f.kind === "choice") return Object.keys(f.criteria ?? {}).length >= 2;
  if (f.kind === "noul") return Boolean(f.noulCriteria?.true?.trim() && f.noulCriteria?.false?.trim());
  return true;
}

/**
 * Put a library field back together when it arrives without its definition.
 *
 * The Settings tab saves the policy it was sent, so a field known only by its summary
 * (id, label, kind, weight) would be written with no instruction and no levels, and the
 * validator rejects it as `extraFields.<id>`. Library entries ship switched off, so that
 * was the first thing a user met when switching one on.
 *
 * A field carrying its own judgment is passed through untouched, so wording edited by
 * hand survives. Only a field that cannot stand alone is repaired, and then wholesale
 * from the library, so levels and their credits stay a matched pair.
 */
export function hydrateLibraryField(field: ExtraField): ExtraField {
  const lib = LIBRARY_BY_ID[field.id];
  if (!lib) return field; // a custom field: the caller is the only definition there is
  if (hasOwnJudgment(field)) {
    // The library owns the kind: a client may spell `noul` as its display name, `yesno`.
    return { ...field, kind: lib.kind };
  }
  return {
    ...structuredClone(lib),
    ...field,
    label: field.label?.trim() ? field.label : lib.label,
    kind: lib.kind,
    instructions: lib.instructions,
    criteria: structuredClone(lib.criteria),
    choiceValues: lib.choiceValues ? structuredClone(lib.choiceValues) : undefined,
    noulCriteria: lib.noulCriteria ? structuredClone(lib.noulCriteria) : undefined,
    noulPolarity: lib.noulPolarity,
    reviewWhen: lib.reviewWhen ? structuredClone(lib.reviewWhen) : undefined,
  };
}

export function libraryMeta() {
  return FIELD_LIBRARY.map(({ id, label, help, source, kind, mode, weight, note }) => ({
    id,
    label,
    help,
    source,
    kind,
    mode,
    weight,
    note,
  }));
}
