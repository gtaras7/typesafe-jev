/**
 * Offline tests for the evaluation harness. No API key, no network.
 *
 * The harness grades Jev, so if the harness itself is wrong every conclusion drawn from
 * it is wrong. These lock down the comparison logic and the labels-file integrity check.
 * Run with: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  buildResults,
  compareAnswer,
  loadLabels,
  summarize,
  summarise,
  verifyLabels,
  noulToBoolean,
  type CvLabels,
} from "./eval-compare.js";
import { buildQuestions, TODAY_TOKEN } from "./questions.js";
import { FOOD_INDUSTRY_QA as role } from "./role-spec.js";
import type { Answers, Questions } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const questions: Questions = buildQuestions(role, TODAY_TOKEN);

const noul = (p: number) => ({ type: "noul" as const, noul: p });
const choice = (pick: string, confidence = 0.9) => ({
  type: "choice" as const,
  choice: pick,
  probabilities: { [pick]: confidence, other_not_accepted: 1 - confidence },
  confidence,
});
const score = (pos: number, levels = 4, confidence = 0.9) => {
  const raw = pos * (levels - 1);
  const lo = Math.floor(raw);
  const hi = Math.min(levels - 1, lo + 1);
  const frac = raw - lo;
  const probabilities: Record<string, number> = {};
  for (let i = 0; i < levels; i++) probabilities[String(i)] = 0;
  if (lo === hi) {
    // a position landing exactly on a level: all the mass on that level, otherwise
    // the two assignments below would overwrite each other and leave every level at 0
    probabilities[String(lo)] = 1;
  } else {
    probabilities[String(lo)] = 1 - frac;
    probabilities[String(hi)] = frac;
  }
  return { type: "score" as const, score: raw, legend: {}, probabilities, confidence };
};

test("noul converts to boolean at the same threshold the policy uses", () => {
  assert.equal(noulToBoolean(0.99), true);
  assert.equal(noulToBoolean(0.5), true);
  assert.equal(noulToBoolean(0.49), false);
  assert.equal(noulToBoolean(0), false);
});

test("an exact match counts as agreement", () => {
  const r = compareAnswer(questions.education!, choice("food_technology"), "food_technology");
  assert.equal(r.status, "match");
  assert.equal(r.actual, "food_technology");
  assert.match(r.detail, /conf=/);
});

test("a different option counts as a mismatch and reports what Jev actually said", () => {
  const r = compareAnswer(questions.education!, choice("agronomy"), "food_technology");
  assert.equal(r.status, "mismatch");
  assert.equal(r.actual, "agronomy");
});

test("a label listing several acceptable options accepts any of them", () => {
  const labels = ["food_chemistry", "food_technology"];
  assert.equal(compareAnswer(questions.education!, choice("food_chemistry"), labels).status, "match");
  assert.equal(compareAnswer(questions.education!, choice("food_technology"), labels).status, "match");
  assert.equal(compareAnswer(questions.education!, choice("agronomy"), labels).status, "mismatch");
});

test("a score label compares against Jev's most probable level, not the interpolated position", () => {
  // position 1.0 on 4 levels sits exactly on level 3
  assert.equal(compareAnswer(questions.experience_level!, score(1), 3).status, "match");
  // position 0.75 lands between levels 2 and 3, and the distribution favours 2
  const mid = compareAnswer(questions.experience_level!, score(0.75), 2);
  assert.equal(mid.status, "match");
  assert.equal(mid.actual, 2);
  assert.match(mid.detail, /score=2\.250/);
});

test("an undetermined label is never graded", () => {
  const r = compareAnswer(questions.age_evidence!, choice("over_28_stated"), "undetermined");
  assert.equal(r.status, "undetermined");
  assert.equal(r.actual, null);
  // even a wildly wrong-looking answer is not graded when there is no ground truth
  assert.equal(compareAnswer(questions.age_evidence!, undefined, "undetermined").status, "undetermined");
});

test("an answer missing from the response is reported, not silently skipped", () => {
  const r = compareAnswer(questions.military_status!, undefined, "completed");
  assert.equal(r.status, "missing");
  assert.equal(r.actual, null);
});

test("an answer of the wrong type is a mismatch rather than a crash", () => {
  const r = compareAnswer(questions.education!, noul(0.9) as never, "food_technology");
  assert.equal(r.status, "mismatch");
  assert.match(r.detail, /answer type is noul, expected choice/);
});

test("a question with no label at all is surfaced as a mismatch", () => {
  const answers: Answers = { education: choice("food_technology") };
  const results = buildResults(questions, answers, {
    education: { expected: "food_technology", quote: "x" },
  });
  assert.equal(results.length, Object.keys(questions).length);
  const unlabelled = results.filter((r) => r.detail === "no label for this question");
  assert.equal(unlabelled.length, Object.keys(questions).length - 1);
});

test("summarize excludes undetermined labels from the denominator", () => {
  const answers: Answers = {
    education: choice("food_technology"),
    food_sector_present: noul(0.01),
    age_evidence: choice("over_28_stated"),
  };
  // every question needs a label, or the unlabelled ones count as mismatches and
  // swamp the arithmetic this test is actually about
  const labels = Object.fromEntries(
    Object.keys(questions).map((id) => [id, { expected: "undetermined" as const, quote: "x" }]),
  );
  labels["education"] = { expected: "food_technology", quote: "x" } as never;
  labels["food_sector_present"] = { expected: true, quote: "x" } as never;

  const results = buildResults(questions, answers, labels);
  const s = summarize(results);
  // education agrees, food sector disagrees, everything else is undetermined
  assert.equal(s.matched, 1);
  assert.equal(s.mismatched, 1);
  assert.equal(s.undetermined, Object.keys(questions).length - 2);
  assert.equal(s.determinate, 2);
  assert.equal(s.agreement, 0.5);
  assert.equal(summarise, summarize, "the two spellings must stay the same function");
});

test("agreement is null when nothing is determinate, rather than a divide by zero", () => {
  const results = buildResults(questions, {}, Object.fromEntries(
    Object.keys(questions).map((id) => [id, { expected: "undetermined" as const, quote: "x" }]),
  ));
  const s = summarize(results);
  assert.equal(s.determinate, 0);
  assert.equal(s.agreement, null);
});

test("verifyLabels accepts a CV whose labels are complete and quoted from its text", () => {
  const source = "Some CV text stating Food Technology and 8 years of experience.";
  const cv: CvLabels = {
    kind: "fixture",
    source: "x",
    labels: { education: { expected: "food_technology", quote: "Food Technology" } },
  };
  const res = verifyLabels(cv, source, ["education"]);
  assert.deepEqual(res.missingQuotes, []);
  assert.deepEqual(res.missingQuestions, []);
  assert.deepEqual(res.extraQuestions, []);
});

test("verifyLabels rejects a fabricated quote", () => {
  const cv: CvLabels = {
    kind: "fixture",
    source: "x",
    labels: { education: { expected: "food_technology", quote: "a PhD in Food Science" } },
  };
  const res = verifyLabels(cv, "This CV mentions Food Technology only.", ["education"]);
  assert.deepEqual(res.missingQuotes, ["education"]);
});

test("verifyLabels rejects a missing question and an unknown id", () => {
  const cv: CvLabels = {
    kind: "fixture",
    source: "x",
    labels: {
      education: { expected: "food_technology", quote: "Food Technology" },
      invented_question: { expected: true, quote: "Food Technology" },
    },
  };
  const res = verifyLabels(cv, "Food Technology", ["education", "military_status"]);
  assert.deepEqual(res.missingQuestions, ["military_status"]);
  assert.deepEqual(res.extraQuestions, ["invented_question"]);
});

test("verifyLabels ignores whitespace differences, since extraction reflows the text", () => {
  const cv: CvLabels = {
    kind: "fixture",
    source: "x",
    labels: { education: { expected: "food_technology", quote: "Food\n   Technology" } },
  };
  assert.deepEqual(verifyLabels(cv, "a CV with Food Technology in it", ["education"]).missingQuotes, []);
});

// ---------------------------------------------------------------------------
// The real labels file
// ---------------------------------------------------------------------------
test("evals/labels.json is structurally sound against the real question set", () => {
  const path = resolve(ROOT, "evals", "labels.json");
  if (!existsSync(path)) return;
  const labels = loadLabels(path);
  const ids = Object.keys(questions);

  assert.ok(Object.keys(labels.cvs).length >= 4, "expected at least 4 CVs");
  for (const [key, cv] of Object.entries(labels.cvs)) {
    const { missingQuestions, extraQuestions } = verifyLabels(cv, "unused", ids);
    assert.deepEqual(missingQuestions, [], `${key} is missing labels`);
    assert.deepEqual(extraQuestions, [], `${key} has unknown question ids`);
    assert.ok(cv.kind === "pdf" || cv.kind === "fixture", `${key} has a bad kind`);
    if (cv.kind === "fixture") assert.ok(cv.fixtureKey, `${key} needs a fixtureKey`);
    if (cv.kind === "pdf") assert.ok(cv.path, `${key} needs a path`);
    // every label must carry a non-empty justification
    for (const [id, lab] of Object.entries(cv.labels)) {
      assert.ok(lab.quote && lab.quote.trim().length > 0, `${key}/${id} has no quote`);
      assert.notEqual(lab.expected, undefined, `${key}/${id} has no expected value`);
    }
  }

  // the labels file documents that it is not verified ground truth
  assert.match(String(labels.meta.note ?? ""), /not verified|PROPOSED/i);
});