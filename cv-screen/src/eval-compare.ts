/**
 * Pure answer-to-label comparison for the evaluation harness.
 *
 * Lives here, not inside scripts/eval.ts, so the offline test can exercise the
 * comparison logic with synthetic answers and no API key or network. Only raw
 * per-question answers are compared against the proposed labels. Composite
 * scores, gates and recommendations are deliberately out of scope: another
 * change is reworking how those are computed, so nothing here may depend on
 * their shape beyond screenCv returning `answers`.
 */

import { readFileSync } from "node:fs";
import { isChoice, isNoul, isScore, topLevel } from "./answer-utils.js";
import type { Answer, Answers, Question, Questions } from "./types.js";

/**
 * A label's expected value: a boolean for noul questions, an option name for
 * choice questions, a level index for score questions, or a list of equally
 * acceptable values. The string "undetermined" means the CV does not determine
 * the answer, so no comparison is made.
 */
export type Expected = boolean | number | string | readonly (boolean | number | string)[];

export interface QuestionLabel {
  expected: Expected;
  /** Short verbatim justification copied from the CV text. */
  quote: string;
  /** Free-form explanation for the human reviewer. */
  note?: string;
}

export interface CvLabels {
  kind: "pdf" | "fixture";
  /** Human-readable source identifier, e.g. the filename or fixture key. */
  source: string;
  /** Absolute PDF path, present when kind is "pdf". */
  path?: string;
  /** Fixture key into fixtures/cvs.json, present when kind is "fixture". */
  fixtureKey?: string;
  name?: string;
  note?: string;
  labels: Record<string, QuestionLabel>;
}

export interface LabelsFile {
  meta: Record<string, unknown>;
  cvs: Record<string, CvLabels>;
}

export type CompareStatus = "match" | "mismatch" | "undetermined" | "missing";

export interface Comparison {
  status: CompareStatus;
  /** Jev's answer rendered for display: boolean for noul, option key for choice, level index for score. */
  actual: boolean | number | string | null;
  /** Confidence, probabilities and score position, so decisiveness is visible. */
  detail: string;
}

export interface QuestionResult extends Comparison {
  questionId: string;
  expected: Expected;
  quote: string;
  note?: string;
}

/** The noul threshold compose.ts uses, kept identical so labels line up with reality. */
export const NOUL_THRESHOLD = 0.5;

export function noulToBoolean(noul: number): boolean {
  return noul >= NOUL_THRESHOLD;
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(3) : "?";
}

function probs(probabilities: Record<string, number>): string {
  return Object.entries(probabilities)
    .map(([k, v]) => `${k}:${v.toFixed(2)}`)
    .join(" ");
}

function accepts(expected: Expected, actual: boolean | number | string): boolean {
  if (Array.isArray(expected)) return expected.some((e) => e === actual);
  return expected === actual;
}

/**
 * Compare one raw answer against its label.
 * `answer` may be undefined when the response omitted the question entirely.
 * `expected === "undetermined"` returns "undetermined" regardless of the answer,
 * because there is no ground truth to compare against.
 */
export function compareAnswer(
  question: Question,
  answer: Answer | undefined,
  expected: Expected,
): Comparison {
  if (expected === "undetermined") {
    return { status: "undetermined", actual: null, detail: "label has no ground truth" };
  }
  if (answer === undefined) {
    return { status: "missing", actual: null, detail: "question absent from the response" };
  }

  if (question.type === "noul") {
    if (!isNoul(answer)) {
      return { status: "mismatch", actual: null, detail: `answer type is ${answer.type}, expected noul` };
    }
    const actual = noulToBoolean(answer.noul);
    return {
      status: accepts(expected, actual) ? "match" : "mismatch",
      actual,
      detail: `p(yes)=${fmt(answer.noul)}`,
    };
  }

  if (question.type === "choice") {
    if (!isChoice(answer)) {
      return { status: "mismatch", actual: null, detail: `answer type is ${answer.type}, expected choice` };
    }
    return {
      status: accepts(expected, answer.choice) ? "match" : "mismatch",
      actual: answer.choice,
      detail: `conf=${fmt(answer.confidence)} probs={${probs(answer.probabilities)}}`,
    };
  }

  // score: the label is a level index; Jev's answer is its most probable level.
  if (!isScore(answer)) {
    return { status: "mismatch", actual: null, detail: `answer type is ${answer.type}, expected score` };
  }
  const top = topLevel(answer, question.criteria);
  return {
    status: accepts(expected, top.index) ? "match" : "mismatch",
    actual: top.index,
    detail: `score=${fmt(answer.score)} top=${top.index} conf=${fmt(answer.confidence)} probs={${probs(answer.probabilities)}}`,
  };
}

export interface Summary {
  matched: number;
  mismatched: number;
  missing: number;
  undetermined: number;
  total: number;
  /** Questions that actually had a determinate label, i.e. total minus undetermined. */
  determinate: number;
  /** matched / determinate, or null when no determinate label existed. */
  agreement: number | null;
}

export function summarize(results: readonly QuestionResult[]): Summary {
  let matched = 0;
  let mismatched = 0;
  let missing = 0;
  let undetermined = 0;
  for (const r of results) {
    if (r.status === "match") matched++;
    else if (r.status === "mismatch") mismatched++;
    else if (r.status === "missing") missing++;
    else undetermined++;
  }
  const total = results.length;
  const determinate = total - undetermined;
  return {
    matched,
    mismatched,
    missing,
    undetermined,
    total,
    determinate,
    agreement: determinate > 0 ? matched / determinate : null,
  };
}

/** Alias kept so callers can read as English: summarise(results). */
export const summarise = summarize;

/**
 * Build the full comparison set for one CV.
 * Questions with no label are reported as mismatches rather than silently skipped, so a
 * gap in the labels file cannot look like a pass.
 */
export function buildResults(
  questions: Questions,
  answers: Answers,
  labels: Record<string, QuestionLabel>,
): QuestionResult[] {
  const out: QuestionResult[] = [];
  for (const [questionId, question] of Object.entries(questions)) {
    const label = labels[questionId];
    const comparison = label
      ? compareAnswer(question, answers[questionId], label.expected)
      : { status: "mismatch" as const, actual: null, detail: "no label for this question" };
    out.push({
      questionId,
      ...comparison,
      expected: label?.expected ?? "undetermined",
      quote: label?.quote ?? "",
      ...(label?.note !== undefined ? { note: label.note } : {}),
    });
  }
  return out;
}

export function loadLabels(path: string): LabelsFile {
  return JSON.parse(readFileSync(path, "utf8")) as LabelsFile;
}

/**
 * Offline integrity check for the labels file.
 *
 * The quote is the whole point: a label without a real quote from the CV is an
 * assertion, not evidence. This refuses any label whose quote cannot be found in the
 * source text, so an invented justification cannot survive review.
 */
export function verifyLabels(
  cv: CvLabels,
  sourceText: string,
  knownQuestionIds: readonly string[],
): { missingQuestions: string[]; extraQuestions: string[]; missingQuotes: string[] } {
  const known = new Set(knownQuestionIds);
  const normalise = (s: string) => s.replace(/\s+/g, " ").trim();
  const haystack = normalise(sourceText);

  const missingQuestions: string[] = [];
  for (const id of knownQuestionIds) {
    if (!(id in cv.labels)) missingQuestions.push(id);
  }

  const extraQuestions = Object.keys(cv.labels).filter((id) => !known.has(id));

  const missingQuotes: string[] = [];
  for (const [id, label] of Object.entries(cv.labels)) {
    const quote = normalise(label.quote ?? "");
    if (!quote || !haystack.includes(quote)) missingQuotes.push(id);
  }

  return { missingQuestions, extraQuestions, missingQuotes };
}
