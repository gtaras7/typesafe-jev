/**
 * Tests for the parts that only exist once a second field can be switched on:
 * extra-field scoring, weight normalisation, re-scoring without inference, and the
 * spreadsheet export.
 *
 * These are behaviour contracts, not snapshots. Where a number appears it is derived
 * from the weights in the test, so changing a default weight does not fail the suite
 * for the wrong reason.
 *
 * Run with:  npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOOD_INDUSTRY_QA } from "./role-spec.js";
import { buildQuestions, policyQuestionIds } from "./questions.js";
import { compose, type DimensionResult } from "./compose.js";
import { rowFromStored, histogram } from "./rows.js";
import { normalisePolicy, roleSpecToPolicy, validatePolicy, weightTotal, type Policy } from "./policy.js";
import { BLANK_POLICY } from "./policy.js";
import { libraryField, FIELD_LIBRARY } from "./fields.js";
import { FOOD_INDUSTRY_POLICY, PRESETS, defaultPolicy } from "./presets.js";
import { recomposeAll, missingQuestions } from "./recompose.js";
import { RunStore } from "./store.js";
import { toCsv, csvCell, columnsFor } from "./csv.js";
import type { Answers, NoulAnswer, ChoiceAnswer, ScoreAnswer, Questions } from "./types.js";

const TODAY = "2026-09-17";

const noul = (p: number): NoulAnswer => ({ type: "noul", noul: p });
const choice = (pick: string, probs: Record<string, number>, confidence = 0.9): ChoiceAnswer => {
  const total = Object.values(probs).reduce((a, b) => a + b, 0) || 1;
  return {
    type: "choice",
    choice: pick,
    probabilities: Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, v / total])),
    confidence,
  };
};
/** A Score answer sitting exactly on `level` of an n-level question. */
const onLevel = (level: number, levels: number, confidence = 0.9): ScoreAnswer => {
  const probabilities: Record<string, number> = {};
  for (let i = 0; i < levels; i++) probabilities[String(i)] = i === level ? 1 : 0;
  return { type: "score", score: level, legend: {}, probabilities, confidence };
};

const candidate = { name: "Test", email: "t@example.com" };

/** A strong candidate for the six core dimensions of the food role. */
const coreAnswers: Answers = {
  experience_determinable: noul(0.95),
  experience_level: onLevel(3, 4),
  education: choice("food_technology", { food_technology: 0.95 }),
  food_sector_present: noul(0.95),
  food_sector_depth: onLevel(3, 4),
  age_evidence: choice("over_28_stated", { over_28_stated: 0.95 }),
  military_status: choice("completed", { completed: 0.95 }),
  stability_red_flag: noul(0.05),
  rnd_priority: noul(0.9),
  evidence_quality_flag: noul(0.05),
};

/** The food policy with one library field switched on. */
function policyWith(id: string, overrides: Partial<Policy> = {}): Policy {
  const field = libraryField(id)!;
  return normalisePolicy({
    ...FOOD_INDUSTRY_POLICY,
    ...overrides,
    extraFields: [{ ...field, enabled: true }],
  });
}

function runWith(policy: Policy, answers: Answers) {
  const questions: Questions = buildQuestions(policy, TODAY);
  return { questions, result: compose(policy, questions, answers, candidate) };
}

const dim = (
  r: { dimensions: DimensionResult[] },
  id: string,
): DimensionResult | undefined => r.dimensions.find((d) => d.id === id);

/* ------------------------------------------------------ the original role is intact */

test("the food policy is a faithful copy of the verified role spec", () => {
  const p = roleSpecToPolicy(FOOD_INDUSTRY_QA);
  assert.equal(p.roleTitle, FOOD_INDUSTRY_QA.title);
  assert.deepEqual(p.weights, FOOD_INDUSTRY_QA.weights);
  assert.deepEqual(p.caps, FOOD_INDUSTRY_QA.caps);
  assert.deepEqual(p.thresholds, FOOD_INDUSTRY_QA.thresholds);
  assert.deepEqual(p.review, FOOD_INDUSTRY_QA.review);
  assert.deepEqual(p.stability, FOOD_INDUSTRY_QA.stability);
  assert.equal(p.unknownCredit, FOOD_INDUSTRY_QA.unknownCredit);
  assert.equal(p.educationNoMatchKey, FOOD_INDUSTRY_QA.educationNoMatchKey);
  assert.equal(p.rejectingGates.length, 1);
  assert.deepEqual(p.extraFields, []);
});

test("a policy and its role spec score identically, bit for bit", () => {
  const questions = buildQuestions(FOOD_INDUSTRY_QA, TODAY);
  const fromSpec = compose(FOOD_INDUSTRY_QA, questions, coreAnswers, candidate);
  const fromPolicy = compose(roleSpecToPolicy(FOOD_INDUSTRY_QA), questions, coreAnswers, candidate);
  assert.equal(fromSpec.composite, fromPolicy.composite);
  assert.equal(fromSpec.rawComposite, fromPolicy.rawComposite);
  assert.deepEqual(fromSpec.reviewReasons, fromPolicy.reviewReasons);
});

test("the six weighted core weights still sum to one, so the normaliser is a no-op", () => {
  const total = weightTotal(FOOD_INDUSTRY_POLICY);
  assert.ok(Math.abs(total - 1) < 5e-16, `sum ${total}`);
  const { result } = runWith(FOOD_INDUSTRY_POLICY, coreAnswers);
  const summed = result.dimensions.reduce((s, d) => s + d.contribution, 0);
  assert.ok(Math.abs(summed - result.rawComposite) < 1e-3);
});

/* ------------------------------------------------------------------ extra fields */

test("a switched-on field carries its own weight and joins the normaliser", () => {
  const policy = policyWith("career_progression");
  assert.equal(policy.extraFields[0]!.weight, 0.1);
  const total = weightTotal(policy);
  assert.ok(Math.abs(total - 1.1) < 1e-9, `sum ${total}`);

  const answers: Answers = { ...coreAnswers, career_progression: choice("steady_growth", { steady_growth: 0.9 }) };
  const { result } = runWith(policy, answers);
  const d = dim(result, "career_progression")!;
  assert.equal(d.weight, 0.1, "the field's own weight is used, not a lookup in the core weights");
  assert.equal(d.value, 1);
  assert.ok(Math.abs(d.contribution - 0.1 / 1.1) < 1e-4, `contribution ${d.contribution}`);

  // Every dimension at full credit now scores exactly 1.0, because the normaliser
  // divides by 1.1 rather than dropping the extra weight.
  assert.equal(result.composite, 1);
});

test("career progression maps each option to the credit the policy declares", () => {
  const policy = policyWith("career_progression");
  const cases: Array<[string, number]> = [
    ["steady_growth", 1],
    ["lateral_moves", 0.65],
    ["job_hopping", 0.25],
    ["unclear", policy.unknownCredit],
  ];
  for (const [option, want] of cases) {
    const answers: Answers = { ...coreAnswers, career_progression: choice(option, { [option]: 0.9 }) };
    const { result } = runWith(policy, answers);
    const d = dim(result, "career_progression")!;
    assert.equal(d.value, want, `${option} -> ${d.value}`);
    assert.equal(result.fields.career_progression, option);
    if (option === "unclear") {
      assert.equal(d.unknown, true);
      assert.ok(
        result.reviewReasons.some((x) => /came back as Unclear/.test(x)),
        result.reviewReasons.join("; "),
      );
    }
  }
});

test("an option the policy assigns no credit to is treated as unknown, not as zero", () => {
  const policy = normalisePolicy({
    ...policyWith("career_progression"),
    extraFields: [
      {
        ...libraryField("career_progression")!,
        enabled: true,
        choiceValues: { steady_growth: 1 },
      },
    ],
  });
  const answers: Answers = { ...coreAnswers, career_progression: choice("job_hopping", { job_hopping: 0.9 }) };
  const { result } = runWith(policy, answers);
  const d = dim(result, "career_progression")!;
  assert.equal(d.value, policy.unknownCredit);
  assert.equal(d.unknown, true);
});

test("an ordered extra scale normalises from its first to its last level", () => {
  const policy = policyWith("technical_depth");
  const field = policy.extraFields[0]!;
  const levels = (field.criteria as string[]).length;
  assert.equal(levels, 6, "the depth scale has the six levels the project author wrote");

  for (const [level, want] of [
    [0, 0],
    [3, 0.6],
    [5, 1],
  ] as Array<[number, number]>) {
    const answers: Answers = { ...coreAnswers, technical_depth: onLevel(level, levels) };
    const { result } = runWith(policy, answers);
    assert.equal(dim(result, "technical_depth")!.value, want, `level ${level}`);
    assert.equal(result.fields.technical_depth, String(level));
  }
});

test("a flag field is visible, reviewable, and never scored", () => {
  const field = libraryField("employment_gaps")!;
  const policy = normalisePolicy({
    ...FOOD_INDUSTRY_POLICY,
    extraFields: [{ ...field, enabled: true, mode: "flag" }],
  });
  const withGap = runWith(policy, { ...coreAnswers, employment_gaps: noul(0.9) });
  const without = runWith(policy, { ...coreAnswers, employment_gaps: noul(0.05) });

  assert.equal(dim(withGap.result, "employment_gaps")!.weight, 0);
  assert.equal(dim(withGap.result, "employment_gaps")!.contribution, 0);
  assert.equal(
    withGap.result.composite,
    without.result.composite,
    "a flag can never move the score",
  );
  assert.equal(withGap.result.fields.employment_gaps, "yes");
  assert.equal(without.result.fields.employment_gaps, "no");
  assert.ok(withGap.result.reviewReasons.some((x) => /may be an issue/.test(x)));
  assert.ok(
    !withGap.result.strengths.some((s) => /gaps/i.test(s)),
    "a flag must not read as a strength or a gap",
  );
});

test("a question the CV was never asked is left out, and the row says so", () => {
  const policy = policyWith("career_progression");
  const { result } = runWith(policy, coreAnswers); // no career answer at all
  assert.equal(result.awaitingRescan, true, "the row must ask for one more pass");
  assert.equal(dim(result, "career_progression"), undefined, "no invented credit");
  assert.equal(result.dimensions.length, 6, "the six answered dimensions only");
  // The unanswered field's weight leaves the normaliser with it, so the candidate is
  // not punished for a question we never asked. The score stays provisional instead.
  assert.equal(result.composite, 1, "the score covers what was actually asked");
  assert.ok(result.reviewReasons.some((x) => /has not been asked about/.test(x)));
});

test("answering that question afterwards lowers the score only through its own credit", () => {
  const policy = policyWith("career_progression");
  const withoutAnswer = runWith(policy, coreAnswers).result;
  const withAnswer = runWith(policy, {
    ...coreAnswers,
    career_progression: choice("job_hopping", { job_hopping: 0.9 }),
  }).result;
  // 1.0 of core credit plus 0.25 of the new field, over 1.1 of weight.
  const expected = (1 + 0.1 * 0.25) / 1.1;
  assert.ok(
    Math.abs(withAnswer.composite - expected) < 1e-3,
    `${withAnswer.composite} vs ${expected.toFixed(4)}`,
  );
  assert.ok(withAnswer.composite < withoutAnswer.composite);
});

test("missingQuestions lists exactly what the policy wants and the row lacks", () => {
  const policy = policyWith("career_progression");
  const core = missingQuestions(FOOD_INDUSTRY_POLICY, coreAnswers);
  assert.deepEqual(core, [], "the core answers cover the core policy");
  const short = missingQuestions(policy, coreAnswers);
  assert.deepEqual(short, ["career_progression"]);
});

/* ------------------------------------------------------------------ validation */

test("validation refuses a policy that could not produce a decision", () => {
  const zeroed = normalisePolicy({
    ...BLANK_POLICY,
    weights: { experience_years: 0, education: 0, food_sector: 0, age_over_28: 0, military: 0, stability: 0 },
  });
  assert.ok(validatePolicy(zeroed).some((i) => i.path === "weights"));

  const bad = normalisePolicy({ ...BLANK_POLICY, thresholds: { interview: 0.4, maybe: 0.6 } });
  assert.ok(validatePolicy(bad).some((i) => i.path === "thresholds"));

  const emptyField = normalisePolicy({
    ...FOOD_INDUSTRY_POLICY,
    extraFields: [{ ...libraryField("career_progression")!, enabled: true, label: "  " }],
  });
  assert.ok(validatePolicy(emptyField).some((i) => /Give the field a name/.test(i.message)));

  const oneLevel = normalisePolicy({
    ...FOOD_INDUSTRY_POLICY,
    extraFields: [
      { ...libraryField("technical_depth")!, enabled: true, criteria: ["only one level"] },
    ],
  });
  assert.ok(validatePolicy(oneLevel).some((i) => /at least two levels/.test(i.message)));

  assert.deepEqual(validatePolicy(defaultPolicy()), [], "the shipped default is valid");
  for (const preset of PRESETS) {
    assert.deepEqual(validatePolicy(preset.policy), [], `${preset.id} must be valid`);
  }
});

test("every question the policy asks is in the question map, and vice versa", () => {
  for (const policy of [FOOD_INDUSTRY_POLICY, policyWith("career_progression"), ...PRESETS.map((p) => p.policy)]) {
    const questions = buildQuestions(policy, TODAY);
    assert.deepEqual(policyQuestionIds(policy).sort(), Object.keys(questions).sort());
    for (const id of Object.keys(questions)) {
      const field = policy.extraFields.find((f) => f.id === id);
      if (field) assert.equal(field.enabled, true, `${id} is asked but switched off`);
    }
  }
});

test("the field library ships every entry switched off, with a usable question", () => {
  for (const entry of FIELD_LIBRARY) {
    assert.equal(entry.enabled, false, `${entry.id} must ship off`);
    assert.ok(entry.instructions.length > 40, `${entry.id} needs a real instruction`);
    if (entry.kind === "score") assert.ok(Array.isArray(entry.criteria) && entry.criteria.length >= 2);
    if (entry.kind === "choice") assert.ok(Object.keys(entry.criteria ?? {}).length >= 2);
    if (entry.kind === "noul") assert.ok(entry.noulCriteria?.true && entry.noulCriteria?.false);
    // A choice whose options carry no credit would silently fall back to partial credit
    // for every answer, which is the kind of thing that looks fine and scores nothing.
    if (entry.kind === "choice" && entry.mode === "weight") {
      const credited = Object.keys(entry.choiceValues ?? {});
      const options = Object.keys(entry.criteria ?? {});
      assert.ok(
        credited.length >= options.length - 1,
        `${entry.id}: ${options.length} options but only ${credited.length} credited`,
      );
    }
  }
});

/* ------------------------------------------------------- re-scoring, for free */

test("changing a weight re-scores stored runs with no tokens and leaves the judgments alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-store-"));
  try {
    const store = new RunStore(join(dir, "jev.sqlite"));
    const policy = FOOD_INDUSTRY_POLICY;
    // Deliberately not a perfect candidate: with every dimension at full credit any
    // reweighting still comes to 1.0, and the test would prove nothing.
    const answers: Answers = {
      ...coreAnswers,
      military_status: choice("not_stated", { not_stated: 0.9 }),
      food_sector_depth: onLevel(1, 4),
    };
    const questions = buildQuestions(policy, TODAY);
    const result = compose(policy, questions, answers, candidate);
    const { id } = store.save({
      policyId: policy.id,
      policy,
      questions,
      candidateName: "Eirini Stamatou",
      candidateEmail: "",
      sourceFile: "eirini.pdf",
      sha256: "a".repeat(64),
      cvText: "cv text",
      composite: result.composite,
      rawComposite: result.rawComposite,
      capped: result.capped,
      recommendation: result.recommendation,
      priority: result.priority.flagged,
      priorityP: result.priority.probability,
      educationOk: result.gates.educationAccepted,
      foodSectorOk: result.gates.foodSectorPresent,
      stabilityRedFlag: result.gates.stabilityRedFlag,
      needsReview: result.needsHumanReview,
      needsRescan: false,
      reviewReasons: result.reviewReasons,
      fields: result.fields,
      model: "jev-1.13.0",
      inputTokens: 3597,
      outputTokens: 0,
      elapsedMs: 1200,
      answers,
      result,
    });

    // A policy that cares much more about the sector and much less about stability.
    const retuned = normalisePolicy({
      ...policy,
      weights: { ...policy.weights, food_sector: 0.45, stability: 0.05, experience_years: 0.1 },
    });
    const outcome = recomposeAll(store, retuned);
    assert.equal(outcome.tokens, 0, "re-scoring must never call the model");
    assert.equal(outcome.n, 1);
    assert.equal(outcome.requiresInference, 0, "nothing new was asked");
    assert.ok(outcome.changed >= 1);

    const stored = store.get(id)!;
    assert.equal(JSON.parse(stored.answers_json).food_sector_depth.score, (answers.food_sector_depth as ScoreAnswer).score);
    assert.equal(stored.input_tokens, 3597, "the token spend of the original run is preserved");
    assert.equal(JSON.parse(stored.questions_json).food_sector_depth.type, "score");
    assert.equal(JSON.parse(stored.policy_json).roleTitle, policy.roleTitle);

    const after = store.get(id)!;
    assert.notEqual(after.composite, result.composite, "the score must move");

    // Adding a question is the one thing that needs the model, and only for the rows
    // that have no answer for it.
    const extended = normalisePolicy({
      ...retuned,
      extraFields: [{ ...libraryField("career_progression")!, enabled: true }],
    });
    const second = recomposeAll(store, extended);
    assert.equal(second.tokens, 0);
    assert.equal(second.requiresInference, 1, "one row is now missing a question");
    const stale = store.get(id)!;
    assert.equal(stale.needs_rescan, 1);
    assert.ok(
      rowFromStored(stale).reviewReasons.some((x) => /has not been asked about/.test(x)),
      "the row must say why it is provisional",
    );
    const restored = recomposeAll(store, retuned);
    assert.equal(restored.requiresInference, 0, "removing the field clears the flag again");
    assert.equal(store.get(id)!.needs_rescan, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------- the export */

test("the csv header follows the policy, in policy order", () => {
  const policy = policyWith("career_progression");
  const cols = columnsFor(policy).map((c) => c.key);
  // With no rows the separator defaults to a comma, so split on either.
  const header = toCsv([], policy).replace(/^\uFEFF/, "").trim().split(/[,;]/);
  assert.equal(header[0], "Candidate");
  assert.ok(header.includes("Match score"));
  // core dimensions in their declared order, then the extra field, then the audit tail
  assert.ok(header.indexOf("Experience (years)") < header.indexOf("Education category"));
  assert.ok(header.indexOf("Education category") < header.indexOf("Job stability"));
  assert.ok(header.indexOf("Job stability") < header.indexOf("Career progression"));
  assert.ok(cols.includes("career_progression"));
});

test("csv cells survive commas, quotes and newlines", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('he said "yes"'), '"he said ""yes"""');
  assert.equal(csvCell("one\n two"), '"one\n two"');
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell(0.912), "0.912");
});

test("the export uses semicolons when the data itself contains commas", () => {
  const { result } = runWith(policyWith("career_progression"), {
    ...coreAnswers,
    career_progression: choice("steady_growth", { steady_growth: 0.9 }),
  });
  const row = rowFromStored({
    id: 1,
    created_at: new Date().toISOString(),
    policy_id: "p",
    scored_policy_id: "p",
    candidate_name: "Παπαδόπουλος, Νικόλαος",
    candidate_email: "",
    source_file: "cv.pdf",
    file_sha256: "b".repeat(64),
    cv_chars: 100,
    cv_text: "x",
    composite: result.composite,
    raw_composite: result.rawComposite,
    capped: 0,
    recommendation: result.recommendation,
    priority: 0,
    priority_p: 0,
    education_ok: 1,
    food_sector_ok: 1,
    stability_red_flag: 0,
    needs_review: 0,
    needs_rescan: 0,
    review_reasons: "",
    fields_json: JSON.stringify(result.fields),
    model: "jev-1.13.0",
    input_tokens: 10,
    output_tokens: 5,
    elapsed_ms: 900,
    answers_json: "{}",
    questions_json: "{}",
    policy_json: "{}",
    result_json: JSON.stringify(result),
  });
  const csv = toCsv([row], policyWith("career_progression"));
  assert.ok(csv.startsWith("\uFEFF"), "excel needs the byte order mark for Greek names");
  assert.ok(csv.includes(";"), "semicolon separated because the name contains a comma");
  assert.ok(csv.includes('"Παπαδόπουλος, Νικόλαος"'));

  const hist = histogram([row], "career_progression", "Career progression", "choice");
  assert.deepEqual(hist.buckets, [["steady_growth", 1]]);
});
