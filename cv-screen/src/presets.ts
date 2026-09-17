/**
 * Seniority presets offered in the UI: entry / junior / senior / CEO.
 *
 * They share the same Jev state and question structure but differ in:
 *   - `minExperienceYears` + custom `experienceLevels`
 *   - `weights` (motivation first for entry, ownership first for senior/CEO)
 *   - `thresholds` and `review.minConfidence` (tighten as seniority rises)
 *   - Extra-field instructions/criteria (same IDs, rewritten rubrics)
 *   - Stability window / employer cap
 *   - `rejectingGates: []` — no hard-fail on education or sector
 *
 * `FOOD_INDUSTRY_POLICY` is kept for the eval harness only — it is not a UI preset.
 */

import { FOOD_INDUSTRY_QA } from "./role-spec.js";
import { normalisePolicy, roleSpecToPolicy, type ExtraField, type Policy } from "./policy.js";

/** Eval baseline: six dimensions, no extra fields. Not listed in the UI dropdown. */
export const FOOD_INDUSTRY_POLICY: Policy = roleSpecToPolicy(FOOD_INDUSTRY_QA);

export interface Preset {
  id: string;
  label: string;
  help: string;
  policy: Policy;
}

export const PRESETS: Preset[] = [
  // ---------- Entry level --------------------------------------------------
  {
    id: "entry-level-job",
    label: "Entry level job",
    help: "First or second job: any real-world experience is the bar. Motivation and trajectory count most; stability and depth are forgiven. Interview line set at 0.65.",
    policy: normalisePolicy({
      id: "entry-level-job",
      roleTitle: "Entry level position",
      minExperienceYears: 1,
      // Custom experience rubric: an internship already meets the bar.
      experienceInstructions:
        "How much professional work experience does this candidate have? An internship, a placement, or under a year of paid work already meets the bar for an entry-level hire.",
      experienceLevels: [
        {
          what: "No professional work experience at all — no paid roles, no internships, no real-world projects",
          examples: ["Student with only coursework and club memberships"],
        },
        {
          what: "One internship, a placement, or under 6 months of paid work — at the entry-level bar",
          examples: ["Three-month summer internship", "Part-time work during studies"],
        },
        {
          what: "6 months to under 2 years in professional roles, a genuine first full-time job",
          examples: ["11-month junior role", "Two consecutive internships"],
        },
        {
          what: "2 years or more of professional experience — above the entry-level bar",
          examples: ["Two years across two companies", "2.5 years at one employer"],
        },
      ],
      acceptedEducation: [],
      educationNoMatchKey: "other_not_accepted",
      // Entry: years barely matter — candidates won't have many. Motivation + hands-on carry the score.
      weights: {
        experience_years: 0.10,
        education: 0,
        food_sector: 0,
        age_over_28: 0,
        military: 0,
        stability: 0.05,
      },
      // Very soft caps: a non-matching degree or no sector history should never
      // disqualify an entry-level candidate.
      caps: { educationNotAccepted: 0.90, noFoodSector: 0.95 },
      unknownCredit: 0.47,
      stability: { maxEmployers: 5, windowYears: 3 },
      priorityKeywords: [],
      thresholds: { interview: 0.65, maybe: 0.40 },
      // Wider uncertainty band: entry-level CVs are shorter and noisier, so a borderline
      // call needs less evidence to be flagged for a human.
      review: { minConfidence: 0.55, borderlineLow: 0.30, borderlineHigh: 0.65 },
      rejectingGates: [],
      age: { enabled: false, minAge: 18 },
      military: { enabled: false, fullCreditIfNotApplicable: true, question: "" },
      sector: { enabled: false, label: "the required sector", question: "" },
      extraFields: [
        // Motivation carries the most weight: does this person want to do this kind of work?
        {
          id: "motivation_fit",
          label: "Direction of the CV",
          help: "Whether the CV points toward this kind of work.",
          kind: "choice",
          mode: "weight",
          weight: 0.30,
          instructions:
            "Setting aside whether this candidate is experienced enough, does the direction of this CV point at the work being hired for? For entry level, a relevant degree, a portfolio project, or even a stated interest in the right field counts as alignment. Judge trajectory and intent, not depth or seniority.",
          criteria: {
            clearly_aligned:
              "Degree, projects, or stated interests clearly point at this kind of work, and this role is a natural first or second step.",
            adjacent:
              "Some relevant coursework, a side project, or a related internship, but the main direction is different from this role.",
            different_direction:
              "The history points entirely at different work, with no visible connection to this field.",
            unclear: "Too little in the CV to tell what the candidate is aiming at.",
          },
          choiceValues: { clearly_aligned: 1, adjacent: 0.65, different_direction: 0.20 },
          reviewWhen: { options: ["unclear"] },
          enabled: true,
        },
        // Hands-on depth: supervised real-world work is the target, not solo ownership.
        {
          id: "technical_depth",
          label: "Hands-on depth",
          help: "For entry level: supervised work in a real environment is the target, not solo ownership.",
          kind: "score",
          mode: "weight",
          weight: 0.25,
          instructions:
            "Rate this candidate's hands-on depth for an entry-level hire. Supervised work in a real environment — bug fixes, tests, a meaningful internship contribution — is the target level. Coursework or bootcamp projects are acceptable. Do not penalise someone for not yet owning a system end to end. Score the highest level clearly shown. When torn between two levels, pick the lower.",
          criteria: [
            {
              what: "No hands-on or technical work of any kind — no code, no lab, no workshop",
              examples: ["CV lists only soft skills and club memberships"],
            },
            {
              what: "Coursework, bootcamp exercises, or tutorial projects only — nothing deployed or used by others",
              examples: ["University final project", "A cloned tutorial app", "Data-science notebook from a course"],
            },
            {
              what: "Supervised work inside a real codebase or system: bug fixes, small features, tests, or an internship contribution that shipped",
              examples: ["Fixed bugs in a live service during an internship", "Added test coverage to a team repo"],
            },
            {
              what: "Owns a small feature or module end to end in a professional setting, within someone else's wider system — above the entry bar",
              examples: ["Built and shipped one feature customers use", "Wrote and maintains one internal tool"],
            },
            {
              what: "Independently owns a service or system in production — well above entry level",
              examples: ["Sole maintainer of a production microservice"],
            },
          ],
          enabled: true,
        },
        // Communication: even a blog post or a class presentation is a positive signal.
        {
          id: "communication",
          label: "Communication",
          help: "Any external-facing written or spoken work, however small.",
          kind: "score",
          mode: "weight",
          weight: 0.15,
          instructions:
            "How much evidence is there of written or spoken communication aimed at people outside the candidate's immediate team or course group? For entry level, even a blog, a class presentation, or a single client interaction is a positive signal. Ignore self-descriptions like 'excellent communicator'.",
          criteria: [
            "No evidence of communication outside the candidate's immediate circle.",
            "Wrote for their own team or course group, or presented to a small peer audience.",
            "Produced material used by people outside their immediate team, or had client-facing contact.",
            "Regularly writes for an external audience or represents an organisation to clients, partners, or the public.",
          ],
          enabled: true,
        },
        // Career trajectory: consistent direction matters more than growth at this stage.
        {
          id: "career_progression",
          label: "Career trajectory",
          help: "For entry level: consistent direction, even from a short history.",
          kind: "choice",
          mode: "weight",
          weight: 0.10,
          instructions:
            "For an entry-level candidate, judge the direction of the CV rather than whether it shows growth in responsibility. Has this person moved consistently toward one kind of work, or is the history scattered? A short CV with no full-time jobs but a clear direction is a positive signal. When the CV is too sparse to read, choose unclear.",
          criteria: {
            steady_growth:
              "The moves so far — education, projects, internships — build clearly toward one kind of work. Each step connects to the last.",
            lateral_moves:
              "Experience is mixed or general, with no clear directional movement, but no sign of instability either.",
            job_hopping:
              "Multiple short, unrelated engagements with no pattern, not explained by study, relocation, or fixed-term contracts.",
            unclear: "Too sparse, too early, or too inconsistent to see any shape at all.",
          },
          choiceValues: { steady_growth: 1, lateral_moves: 0.65, job_hopping: 0.30 },
          reviewWhen: { options: ["unclear"] },
          enabled: true,
        },
      ] as ExtraField[],
    }),
  },

  // ---------- Junior level -------------------------------------------------
  {
    id: "junior-level-job",
    label: "Junior level job",
    help: "1–3 years: can work independently on defined tasks. Technical depth at the 'owns features' level is the target. Career direction and progression matter. Interview line set at 0.72.",
    policy: normalisePolicy({
      id: "junior-level-job",
      roleTitle: "Junior level position",
      minExperienceYears: 2,
      experienceInstructions:
        "How many years of professional work experience does this candidate have? Count all paid roles and treat concurrent freelance work as a single run. The bar is 2 years.",
      experienceLevels: [
        {
          what: "Under 1 year of professional experience — internships or very short first roles",
          examples: ["Six-month placement only", "One role under a year"],
        },
        {
          what: "1 to under 2 years — approaching the junior bar but not yet there",
          examples: ["One role for 18 months", "Two short stints totalling 1.5 years"],
        },
        {
          what: "2 to under 4 years — meeting the junior bar",
          examples: ["Two years at one company", "Three years across two roles"],
        },
        {
          what: "4 years or more — above the junior bar, moving toward mid-level",
          examples: ["Four years in the industry", "A 5-year first job"],
        },
      ],
      acceptedEducation: [],
      educationNoMatchKey: "other_not_accepted",
      // Junior: clearing the years bar starts to matter; early stability too.
      weights: {
        experience_years: 0.15,
        education: 0,
        food_sector: 0,
        age_over_28: 0,
        military: 0,
        stability: 0.10,
      },
      caps: { educationNotAccepted: 0.85, noFoodSector: 0.95 },
      unknownCredit: 0.47,
      stability: { maxEmployers: 4, windowYears: 4 },
      priorityKeywords: [],
      thresholds: { interview: 0.72, maybe: 0.45 },
      review: { minConfidence: 0.60, borderlineLow: 0.30, borderlineHigh: 0.65 },
      rejectingGates: [],
      age: { enabled: false, minAge: 18 },
      military: { enabled: false, fullCreditIfNotApplicable: true, question: "" },
      sector: { enabled: false, label: "the required sector", question: "" },
      extraFields: [
        // Technical depth is the primary signal: "owns features end to end" is the target.
        {
          id: "technical_depth",
          label: "Hands-on depth",
          help: "For junior: owns features end to end in a real production setting is the target.",
          kind: "score",
          mode: "weight",
          weight: 0.35,
          instructions:
            "Rate this candidate's hands-on engineering depth for a junior hire. The target is someone who owns features end to end in a professional setting — from design through shipping and keeping them running — under some guidance. Pure coursework is too early; independent system ownership is ahead of target. Score the highest level clearly shown. When torn between two levels, pick the lower.",
          criteria: [
            {
              what: "No role or project where the candidate did real technical work",
              examples: ["A finance CV with only spreadsheets", "A manager who only describes others' work"],
            },
            {
              what: "Only coursework, bootcamp, or tutorial work — nothing used in a real production environment",
              examples: ["University project", "Cloned tutorial app", "Bootcamp capstone nobody uses"],
            },
            {
              what: "Supervised work in a real codebase: bug fixes, small features, tests inside someone else's design",
              examples: ["Fixed bugs in a live service", "Added tests and small features to a team codebase"],
            },
            {
              what: "Owns features end to end, from design through shipping and keeping them running — the junior target level",
              examples: ["Built and shipped a feature customers use", "Owns an API from design through on-call"],
            },
            {
              what: "Owns a whole service or system and makes its architectural decisions — above the junior bar",
              examples: ["Designed and ran the platform a team builds on", "Chose the architecture and answered for it"],
            },
            {
              what: "Deep specialist with real breadth across more than one domain — senior, not junior",
              examples: ["Rebuilt a system under load and fixed performance across layers"],
            },
          ],
          enabled: true,
        },
        // Career shape: consistent direction and at least steady responsibility.
        {
          id: "career_progression",
          label: "Career progression",
          help: "Whether each step connects to the last and responsibility is at least steady.",
          kind: "choice",
          mode: "weight",
          weight: 0.20,
          instructions:
            "How has this candidate's career moved over time? For a junior hire, judge whether each step connects to the last and whether responsibility is at least steady, if not growing. A first job with no hops and a clear technical direction is the minimum bar. Ignore gaps explained by study, parental leave, or military service. When the shape is ambiguous, choose unclear.",
          criteria: {
            steady_growth:
              "Each move is a step forward — more responsibility, a larger scope, or a deeper technical area. The arc is clearly up.",
            lateral_moves:
              "Moves between roles of similar level. Direction is consistent even if not climbing.",
            job_hopping:
              "Three or more stays of roughly under 18 months each, with no stated reason such as a fixed term, relocation, or study.",
            unclear: "Too sparse or inconsistent to see any shape.",
          },
          choiceValues: { steady_growth: 1, lateral_moves: 0.65, job_hopping: 0.25 },
          reviewWhen: { options: ["unclear"] },
          enabled: true,
        },
        // Motivation: does the CV point at this kind of work?
        {
          id: "motivation_fit",
          label: "Direction of the CV",
          help: "Whether the CV is aimed at this kind of role.",
          kind: "choice",
          mode: "weight",
          weight: 0.15,
          instructions:
            "Setting aside seniority, does the direction of this CV point at the work being hired for? For a junior hire, judge whether the technical choices, projects, and employers build toward this kind of role. Ignore any stated wish to work here unless the history supports it.",
          criteria: {
            clearly_aligned:
              "The technical history points at this kind of work, and this role is a natural next step.",
            adjacent:
              "Transferable experience, but this role is a change of direction rather than a continuation.",
            different_direction:
              "The history points at different work, and this role would be a fresh start.",
            unclear: "Too little in the CV to tell what the candidate is aiming at.",
          },
          choiceValues: { clearly_aligned: 1, adjacent: 0.60, different_direction: 0.20 },
          reviewWhen: { options: ["unclear"] },
          enabled: true,
        },
        // Ownership is informational at junior level: a growth signal, not a gate.
        {
          id: "ownership_leadership",
          label: "Ownership and leadership",
          help: "Informational at junior level — a growth signal, not a gate.",
          kind: "score",
          mode: "flag",
          weight: 0,
          instructions:
            "How far does this candidate's responsibility extend beyond their own tasks? At junior level this is informational — a signal of growth potential, not a hiring criterion.",
          criteria: [
            "No evidence of responsibility beyond their own tasks.",
            "Helps colleagues informally, reviews others' work, or explains things to them.",
            "Owns a small project or workstream, or formally mentors one person.",
            "Leads a team or workstream others depend on, with accountability for outcomes.",
            "Leads several teams or sets direction for a whole function or discipline.",
          ],
          enabled: true,
        },
      ] as ExtraField[],
    }),
  },

  // ---------- Senior level -------------------------------------------------
  {
    id: "senior-level-job",
    label: "Senior level job",
    help: "5–8+ years: owns systems and makes architectural decisions. Depth and leadership scope count more than raw years. Interview line set at 0.78.",
    policy: normalisePolicy({
      id: "senior-level-job",
      roleTitle: "Senior level position",
      minExperienceYears: 5,
      experienceInstructions:
        "How many years of professional work experience does this candidate have, treating concurrent freelance or contract work as a single run? The bar is 5 years — but at senior level, depth and ownership matter more than raw years.",
      experienceLevels: [
        {
          what: "Under 2 years of professional experience — too early for a senior role",
          examples: ["One year in the industry"],
        },
        {
          what: "2 to under 5 years — below the senior bar, solid mid-level",
          examples: ["Three years across two companies", "Four years at one employer"],
        },
        {
          what: "5 to under 8 years — at the senior bar",
          examples: ["Six years with increasing scope", "5 years as a senior IC"],
        },
        {
          what: "8 or more years of professional experience — deeply senior, well above the bar",
          examples: ["Ten years across multiple companies", "12-year career with architectural ownership"],
        },
      ],
      acceptedEducation: [],
      educationNoMatchKey: "other_not_accepted",
      weights: {
        // Senior: depth/ownership still lead, but years and staying power weigh more than at junior.
        experience_years: 0.20,
        education: 0,
        food_sector: 0,
        age_over_28: 0,
        military: 0,
        stability: 0.15,
      },
      caps: { educationNotAccepted: 0.85, noFoodSector: 0.95 },
      unknownCredit: 0.47,
      // Longer window and stricter employer cap: a senior career should show staying power.
      stability: { maxEmployers: 3, windowYears: 5 },
      priorityKeywords: [],
      thresholds: { interview: 0.78, maybe: 0.55 },
      // Higher confidence required: at senior level, close calls are worth a human look.
      review: { minConfidence: 0.70, borderlineLow: 0.35, borderlineHigh: 0.70 },
      rejectingGates: [],
      age: { enabled: false, minAge: 18 },
      military: { enabled: false, fullCreditIfNotApplicable: true, question: "" },
      sector: { enabled: false, label: "the required sector", question: "" },
      extraFields: [
        // Technical depth is primary: system ownership and architecture are the target.
        {
          id: "technical_depth",
          label: "Hands-on depth",
          help: "For senior: owns whole systems and makes architectural decisions.",
          kind: "score",
          mode: "weight",
          weight: 0.35,
          instructions:
            "Rate this candidate's hands-on engineering depth for a senior hire. The target is someone who owns whole systems or services and makes their architectural decisions — not just features, but the foundations other features are built on. Strong performance on features alone is mid-level, not senior. Score the highest level clearly shown. When torn between two levels, pick the lower.",
          criteria: [
            {
              what: "No role or project where the candidate did real technical work",
            },
            {
              what: "Only coursework, bootcamp, or tutorial work — no real production contribution",
            },
            {
              what: "Supervised work: bug fixes, small features, tests inside someone else's design — junior level",
            },
            {
              what: "Owns features end to end, from design through shipping — solid mid-level",
              examples: ["Built and shipped features customers use", "Owns an API from design through on-call"],
            },
            {
              what: "Owns a whole service or system and makes its architectural decisions — at the senior target",
              examples: ["Designed and ran the platform the team builds on", "Chose the architecture and answered for its reliability"],
            },
            {
              what: "Deep specialist with real breadth: hard production problems solved across more than one area — the top of senior",
              examples: ["Rebuilt a system under load and fixed performance across layers", "Known for depth in one area and real work in two others"],
            },
          ],
          enabled: true,
        },
        // Ownership and leadership: leads a team or workstream with clear accountability.
        {
          id: "ownership_leadership",
          label: "Ownership and leadership",
          help: "For senior: owns a workstream or small team with accountability for outcomes.",
          kind: "score",
          mode: "weight",
          weight: 0.25,
          instructions:
            "How far does this candidate's responsibility extend beyond their own tasks? For a senior hire, the target is someone who owns a workstream or small team and is accountable for its outcomes — not just a strong individual contributor. Leading several teams or a whole function is above the senior bar but welcome. When torn between two levels, pick the lower.",
          criteria: [
            "No evidence of responsibility beyond their own tasks.",
            "Helps colleagues informally, reviews others' work, or explains things — common at mid-level.",
            "Owns a small project or workstream, or formally mentors one person.",
            {
              what: "Leads a team or workstream others depend on, with clear accountability for outcomes — at the senior target",
              examples: ["Tech lead of a 4-person team", "Owns the release process for a major product line"],
            },
            {
              what: "Leads several teams, or sets direction for a whole function or discipline — above the senior bar",
              examples: ["Director of Engineering over three teams", "Staff engineer setting technical direction for a department"],
            },
          ],
          enabled: true,
        },
        // Career shape: the arc must show upward progression, not a flat plateau.
        {
          id: "career_progression",
          label: "Career progression",
          help: "Whether the trajectory shows consistent growth toward senior scope.",
          kind: "choice",
          mode: "weight",
          weight: 0.15,
          instructions:
            "How has this candidate's career moved over time? For a senior hire, the arc must show clear upward progression — growing scope, harder problems, more ownership. A flat track record of 8 years at similar levels is not a senior story. Ignore gaps explained by study, parental leave, or military service. When the shape is genuinely ambiguous, choose unclear.",
          criteria: {
            steady_growth:
              "Responsibility clearly grows at each step — harder problems, more ownership, wider scope. The arc is clearly upward.",
            lateral_moves:
              "Moves between roles of similar level. Consistent direction but no clear upward step over time.",
            job_hopping:
              "Three or more short stays with no pattern of growing ownership, not explained by fixed terms, relocation, or study.",
            unclear: "Too sparse or contradictory to see a clear trajectory.",
          },
          // lateral moves score lower than at entry/junior: stagnation is a senior-level concern.
          choiceValues: { steady_growth: 1, lateral_moves: 0.50, job_hopping: 0.15 },
          reviewWhen: { options: ["unclear"] },
          enabled: true,
        },
        // Motivation is informational at senior level: domain changes are common.
        {
          id: "motivation_fit",
          label: "Direction of the CV",
          help: "Informational at senior level — domain changes are common and acceptable.",
          kind: "choice",
          mode: "flag",
          weight: 0,
          instructions:
            "Setting aside seniority, does the direction of this CV point at the work being hired for? At senior level this is informational — a senior candidate moving across domains is not unusual, and this field should not influence the score.",
          criteria: {
            clearly_aligned: "The history points at this kind of work, and this role is a natural next step.",
            adjacent: "Transferable experience, but this role is a change of direction.",
            different_direction: "The history points at different work; this role would be a fresh start.",
            unclear: "Too little in the CV to tell.",
          },
          choiceValues: { clearly_aligned: 1, adjacent: 0.6, different_direction: 0.2 },
          enabled: true,
        },
      ] as ExtraField[],
    }),
  },

  // ---------- CEO level ----------------------------------------------------
  {
    id: "ceo-level-job",
    label: "CEO / C-suite level job",
    help: "10+ years: org-level leadership, P&L ownership, external communication. Hands-on technical depth is informational only. Interview line set at 0.82.",
    policy: normalisePolicy({
      id: "ceo-level-job",
      roleTitle: "CEO / C-suite position",
      minExperienceYears: 10,
      experienceInstructions:
        "How many years of professional experience does this candidate have in roles with significant leadership or executive responsibility — managing teams, owning budgets or P&L, or setting strategy for a function or company? Count years where they were clearly accountable for others' outcomes.",
      experienceLevels: [
        {
          what: "Under 5 years of experience, or only individual-contributor roles — too early for a C-suite search",
          examples: ["All roles are IC", "3 years total in the workforce"],
        },
        {
          what: "5 to under 10 years, or leadership confined to team or small department level — developing toward executive scope",
          examples: ["Engineering manager for 3 years then IC again", "Led a 10-person team"],
        },
        {
          what: "10 to under 15 years with clear VP, Director, or equivalent scope — at the C-suite bar",
          examples: ["VP of Engineering for 4 years after 8 years of management", "Head of Product across three teams"],
        },
        {
          what: "15 or more years with progressively senior leadership up to or including C-suite, board, or founding scope",
          examples: ["COO for 6 years after 12 years in management", "Serial founder with two exits"],
        },
      ],
      acceptedEducation: [],
      educationNoMatchKey: "other_not_accepted",
      weights: {
        // CEO: a long track record and continuity matter more than at any lower level;
        // org-level leadership still carries the bulk of the score via extra fields.
        experience_years: 0.25,
        education: 0,
        food_sector: 0,
        age_over_28: 0,
        military: 0,
        stability: 0.20,
      },
      caps: { educationNotAccepted: 0.90, noFoodSector: 0.95 },
      unknownCredit: 0.47,
      // Long window: a CEO track record is read over a decade, not four years.
      stability: { maxEmployers: 3, windowYears: 7 },
      priorityKeywords: [],
      thresholds: { interview: 0.82, maybe: 0.60 },
      // Highest confidence bar: a borderline call on a C-suite candidate always goes to a human.
      review: { minConfidence: 0.75, borderlineLow: 0.35, borderlineHigh: 0.70 },
      rejectingGates: [],
      age: { enabled: false, minAge: 18 },
      military: { enabled: false, fullCreditIfNotApplicable: true, question: "" },
      sector: { enabled: false, label: "the required sector", question: "" },
      extraFields: [
        // Org-level leadership scope is the dominant criterion for a CEO search.
        {
          id: "ownership_leadership",
          label: "Org-level leadership scope",
          help: "For CEO: P&L ownership, setting company direction, or equivalent.",
          kind: "score",
          mode: "weight",
          weight: 0.45,
          instructions:
            "How far does this candidate's leadership scope extend? For a CEO or C-suite search, judge the scale of the decisions they have owned and the organisations they have led. A team lead or department head falls well short of the bar; a founder, COO, or divisional president is at or above it. When torn between two levels, pick the lower.",
          criteria: [
            "No evidence of managing others' work or outcomes.",
            {
              what: "Leads one team or a small cross-functional project with accountability for outcomes — common at mid-level",
              examples: ["Engineering manager for 5 people", "Project lead for a single product"],
            },
            {
              what: "Leads a multi-team department or owns a significant company function with its own headcount and budget",
              examples: ["VP Engineering over 40 people", "Head of Operations with budget responsibility"],
            },
            {
              what: "Sets strategy and is accountable for outcomes across a whole business unit, division, or major company function",
              examples: ["CTO of a 200-person company", "Divisional President with full P&L", "COO of a scale-up"],
            },
            {
              what: "Accountable for the whole company or a major P&L: CEO, MD, or equivalent, or a founder who has grown and led a company",
              examples: ["CEO of a 500-person company", "Founder and MD through Series B", "Country Manager with full P&L"],
            },
          ],
          enabled: true,
        },
        // External communication is a genuine C-suite requirement.
        {
          id: "communication",
          label: "External communication",
          help: "For CEO: board-level, investor, or public-facing communication.",
          kind: "score",
          mode: "weight",
          weight: 0.20,
          instructions:
            "How much of this candidate's communication is aimed at audiences outside their organisation, or at the highest internal levels? For a CEO, board-level reporting, investor relations, public speaking, or a public profile as a company voice is the target. Ignore self-descriptions like 'excellent communicator'.",
          criteria: [
            "No evidence of written or spoken work aimed at anyone outside the candidate's immediate team.",
            "Internal communications: writes for other teams, presents internally, or handles interdepartmental coordination.",
            "External communications: writes publicly, presents at industry events, or works directly with clients, partners, or regulators.",
            {
              what: "Major external presence: board, investors, media, or public — represents the company at the highest level, or has a public profile as a company spokesperson or thought leader",
              examples: ["Regular board presenter", "Quoted as company spokesperson", "Conference keynote speaker", "Author of published industry material"],
            },
          ],
          enabled: true,
        },
        // Executive trajectory: does the arc point toward the top?
        {
          id: "career_progression",
          label: "Executive trajectory",
          help: "Whether the career arc consistently points toward C-suite scope.",
          kind: "choice",
          mode: "weight",
          weight: 0.20,
          instructions:
            "Does the shape of this career show a clear arc toward executive leadership — progressively larger scope, larger organisations, or higher accountability at each move? A flat track of similar leadership roles, or a return to individual-contributor work, counts against the arc. When the shape is too sparse to read, choose unclear.",
          criteria: {
            steady_growth:
              "Each move adds scope, headcount, P&L responsibility, or organisational seniority. The arc clearly points toward the top.",
            lateral_moves:
              "Moves between leadership roles of similar scope without a clear upward step, or a mix of IC and leadership without a clear direction.",
            job_hopping:
              "Many short stints, or a pattern of stepping down from leadership back to IC, not explained by start-up failures or restructuring.",
            unclear: "Too sparse or contradictory to see a trajectory toward executive leadership.",
          },
          choiceValues: { steady_growth: 1, lateral_moves: 0.45, job_hopping: 0.10 },
          reviewWhen: { options: ["unclear"] },
          enabled: true,
        },
        // Technical background is informational only: do not penalise a generalist CEO.
        {
          id: "technical_depth",
          label: "Technical background",
          help: "Informational only for CEO — noted but never scored.",
          kind: "score",
          mode: "flag",
          weight: 0,
          instructions:
            "What is this candidate's hands-on technical background? For a CEO or C-suite search this is informational only — record what the CV shows but do not let it influence the score either way.",
          criteria: [
            "No hands-on technical work evident anywhere in the CV.",
            "Some technical background: coursework, an early-career technical role, or incidental technical work.",
            "Significant technical background: several years as an IC before moving to leadership.",
            "Deep technical specialist before becoming an executive: still known for technical judgment.",
          ],
          enabled: true,
        },
      ] as ExtraField[],
    }),
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
