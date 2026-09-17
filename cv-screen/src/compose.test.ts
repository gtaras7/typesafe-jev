/**
 * Tests for the pure composition layer: no API key, no network.
 * Run with:  npm test
 *
 * These lock down the policy that used to live as prose inside the old prompt,
 * so a weight or gate can be changed deliberately instead of accidentally.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FOOD_INDUSTRY_QA as role } from "./role-spec.js";
import { buildQuestions } from "./questions.js";
import { compose } from "./compose.js";
import { scoreNorm, topLevel } from "./answer-utils.js";
import type { Answers, Questions, ScoreAnswer, ChoiceAnswer, NoulAnswer } from "./types.js";

const TODAY = "2026-09-16";
const questions: Questions = buildQuestions(role, TODAY);

const noul = (p: number): NoulAnswer => ({ type: "noul", noul: p });

function choice(pick: string, probs: Record<string, number>, confidence = 0.9): ChoiceAnswer {
  const total = Object.values(probs).reduce((a, b) => a + b, 0) || 1;
  const norm = Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, v / total]));
  return { type: "choice", choice: pick, probabilities: norm, confidence };
}

/** Score answer from a 0..1 position on a 4 level question. */
function score(pos: number, levels = 4, confidence = 0.9): ScoreAnswer {
  const raw = pos * (levels - 1);
  const lo = Math.floor(raw);
  const hi = Math.min(levels - 1, lo + 1);
  const frac = raw - lo;
  const probabilities: Record<string, number> = {};
  for (let i = 0; i < levels; i++) probabilities[String(i)] = 0;
  if (lo === hi) {
    // exactly on a level: put all the mass there, otherwise the two writes below
    // overwrite each other and every level ends up at zero
    probabilities[String(lo)] = 1;
  } else {
    probabilities[String(lo)] = 1 - frac;
    probabilities[String(hi)] = frac;
  }
  return { type: "score", score: raw, legend: {}, probabilities, confidence };
}

const strong: Answers = {
  experience_determinable: noul(0.9),
  experience_level: score(1),
  education: choice("food_technology", { food_technology: 0.9, other_not_accepted: 0.02 }),
  food_sector_present: noul(0.95),
  food_sector_depth: score(1),
  age_evidence: choice("over_28_stated", { over_28_stated: 0.92 }),
  military_status: choice("completed", { completed: 0.93 }),
  stability_red_flag: noul(0.05),
  rnd_priority: noul(0.95),
  evidence_quality_flag: noul(0.05),
};

const weak: Answers = {
  experience_determinable: noul(0.9),
  experience_level: score(1 / 3),
  education: choice("other_not_accepted", { other_not_accepted: 0.9, food_technology: 0.05 }),
  food_sector_present: noul(0.1),
  food_sector_depth: score(0),
  age_evidence: choice("under_28_stated", { under_28_stated: 0.95 }),
  military_status: choice("not_stated", { not_stated: 0.8 }),
  stability_red_flag: noul(0.05),
  rnd_priority: noul(0.05),
  evidence_quality_flag: noul(0.2),
};

const id = { name: "Test", email: "t@example.com" };
const run = (a: Answers) => compose(role, questions, a, id);
const dim = (r: ReturnType<typeof run>, k: string) => r.dimensions.find((d) => d.id === k)!;

test("question set is one batched call: 10 questions, all ids distinct", () => {
  assert.equal(Object.keys(questions).length, 10);
});

test("weights sum to exactly 1", () => {
  const sum = Object.values(role.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}`);
});

test("every Score question declares at least two levels", () => {
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "score") {
      assert.ok(q.criteria.length >= 2, `${id} has ${q.criteria.length} levels`);
    }
  }
});

test("every closed set has a no-match or not-stated option", () => {
  assert.ok(role.educationNoMatchKey in (questions.education as any).criteria);
  const mil = (questions.military_status as any).criteria;
  assert.ok("not_stated" in mil && "not_applicable_female" in mil);
  const age = (questions.age_evidence as any).criteria;
  assert.ok("not_stated" in age);
});

test("strong food-sector candidate: high composite, INTERVIEW, priority, no review", () => {
  const r = run(strong);
  assert.ok(r.composite > 0.95, `composite ${r.composite}`);
  assert.equal(r.recommendation, "INTERVIEW");
  assert.equal(r.priority.flagged, true);
  assert.equal(r.gates.educationAccepted, true);
  assert.equal(r.gates.foodSectorPresent, true);
  assert.equal(r.capped, false);
  assert.equal(r.needsHumanReview, false, r.reviewReasons.join("; "));
});

test("wrong education and no food sector: both gates fail, composite stays under both caps", () => {
  const r = run(weak);
  assert.equal(r.gates.educationAccepted, false);
  assert.equal(r.gates.foodSectorPresent, false);
  assert.equal(r.recommendation, "PASS");
  assert.ok(r.composite <= role.caps.educationNotAccepted, `composite ${r.composite}`);
  assert.ok(r.composite <= role.caps.noFoodSector, `composite ${r.composite}`);
  assert.equal(r.priority.flagged, false);
});

test("a cap actually binds when the weighted sum would exceed it", () => {
  const r = run({
    ...strong,
    education: choice("other_not_accepted", { other_not_accepted: 0.98 }),
  });
  assert.equal(r.gates.educationAccepted, false);
  assert.ok(r.rawComposite > role.caps.educationNotAccepted, `raw ${r.rawComposite}`);
  assert.equal(r.composite, role.caps.educationNotAccepted);
  assert.equal(r.capped, true);
  assert.match(r.appliedCaps.join(" "), /capped at 0\.5/);
  assert.notEqual(r.recommendation, "INTERVIEW");
});

test("a strong candidate cannot buy their way past a gate", () => {
  // Everything else perfect, education rejected. The cap lands on 0.5, which equals
  // thresholds.maybe, so before rejectingGates existed this wrongly scored MAYBE.
  const r = run({ ...strong, education: choice("other_not_accepted", { other_not_accepted: 0.99 }) });
  assert.equal(r.composite, role.caps.educationNotAccepted);
  assert.equal(r.gates.educationAccepted, false);
  assert.equal(r.recommendation, "PASS");
});

test("the education cap collides with the MAYBE threshold, which is why the gate decides", () => {
  // Guards the exact regression that labelled a disqualified candidate MAYBE.
  assert.equal(role.caps.educationNotAccepted, role.thresholds.maybe);
  assert.ok(role.rejectingGates.includes("education"));
  assert.ok(!role.rejectingGates.includes("foodSector"));
});

test("a failed rejecting gate forces PASS for an otherwise perfect candidate", () => {
  const r = run({ ...strong, education: choice("other_not_accepted", { other_not_accepted: 0.99 }) });
  // The cap binds, and the capped value of 0.5 alone would have scored MAYBE.
  assert.ok(r.rawComposite > role.caps.educationNotAccepted, `raw ${r.rawComposite}`);
  assert.equal(r.composite, role.caps.educationNotAccepted);
  assert.equal(r.recommendation, "PASS");
  assert.ok(
    r.reviewReasons.some((x) => /disqualifying gate failed: education/.test(x)),
    r.reviewReasons.join("; "),
  );
});

test("a failed food-sector gate alone is a penalty, not a rejection", () => {
  const r = run({ ...strong, food_sector_present: noul(0.1) });
  assert.equal(r.gates.foodSectorPresent, false);
  assert.equal(r.composite, role.caps.noFoodSector);
  assert.equal(r.recommendation, "MAYBE");
});

test("a coin-flip stability probability scores its expectation, not a hard zero", () => {
  const mid = run({ ...strong, stability_red_flag: noul(0.51) });
  const d = dim(mid, "stability");
  // 1 - 0.51 = 0.49, so the dimension loses about half its weight instead of all of it
  assert.ok(Math.abs(d.value - 0.49) < 1e-9, `mid-zone value ${d.value}`);
  assert.ok(mid.composite > 0.9 && mid.composite < 0.95, `composite ${mid.composite}`);
  // the model's best call is still recorded for the downstream gates column
  assert.equal(mid.gates.stabilityRedFlag, true);
  assert.ok(mid.reviewReasons.some((x) => /borderline/.test(x)), mid.reviewReasons.join("; "));

  // the decisive zones stay binary, so a perfect composite is still reachable
  assert.equal(dim(run({ ...strong, stability_red_flag: noul(0.8) }), "stability").value, 0);
  assert.equal(dim(run({ ...strong, stability_red_flag: noul(0.2) }), "stability").value, 1);
});

test("an uncertain food-sector probability skips the cap but routes to a human", () => {
  const r = run({ ...strong, food_sector_present: noul(0.5) });
  assert.ok(
    r.reviewReasons.some((x) => /presence is uncertain/.test(x)),
    r.reviewReasons.join("; "),
  );
  // 0.5 sits in the band, so no cap is applied and the weighted value survives
  assert.equal(r.appliedCaps.length, 0);
  assert.ok(r.composite > 0.95, `composite ${r.composite}`);
});

test("unknown age takes the documented partial credit, not zero and not full", () => {
  const r = run({ ...strong, age_evidence: choice("not_stated", { not_stated: 0.9 }) });
  const d = dim(r, "age_over_28");
  assert.equal(d.value, role.unknownCredit);
  assert.equal(d.unknown, true);
  assert.ok(Math.abs(d.contribution - role.weights.age_over_28 * role.unknownCredit) < 1e-6);
  assert.ok(r.needsHumanReview);
  assert.match(r.reviewReasons.join(" "), /Age over 28 is unknown/);
});

test("military service maps each option to the policy value", () => {
  const cases: Array<[string, number]> = [
    ["completed", 1],
    ["exempted", 1],
    ["not_applicable_female", 1],
    ["pending_or_not_completed", 0],
    ["not_stated", 0.5],
  ];
  for (const [opt, want] of cases) {
    const r = run({ ...strong, military_status: choice(opt, { [opt]: 0.95 }) });
    assert.equal(dim(r, "military").value, want, `${opt} -> ${dim(r, "military").value}`);
  }
});

test("stability red flag zeroes that dimension entirely", () => {
  const flagged = run({ ...strong, stability_red_flag: noul(0.8) });
  assert.equal(dim(flagged, "stability").value, 0);
  assert.equal(flagged.gates.stabilityRedFlag, true);
  const clear = run({ ...strong, stability_red_flag: noul(0.05) });
  assert.ok(dim(clear, "stability").value > 0.9);
});

test("undeterminable experience falls back to partial credit", () => {
  const r = run({ ...strong, experience_determinable: noul(0.2) });
  assert.equal(dim(r, "experience_years").value, role.unknownCredit);
  assert.equal(dim(r, "experience_years").unknown, true);
});

test("RnD priority never changes the composite", () => {
  const withFlag = run({ ...strong, rnd_priority: noul(0.99) });
  const without = run({ ...strong, rnd_priority: noul(0.01) });
  assert.equal(withFlag.composite, without.composite);
  assert.equal(withFlag.priority.flagged, true);
  assert.equal(without.priority.flagged, false);
});

test("low answer confidence is a note, and only becomes a review reason on a close call", () => {
  // A close call on a dimension nowhere near a decision line: worth reading, not worth
  // waking a recruiter for. Treating it as a review reason flagged almost every CV in a
  // real folder of 40, which made the flag meaningless.
  const away = run({ ...strong, food_sector_depth: score(1, 4, 0.31) });
  assert.equal(away.needsHumanReview, false, away.reviewReasons.join("; "));
  assert.match(away.notes.join(" "), /close call/);

  // The same uncertainty, on a candidate whose score sits exactly on the interview line.
  const onTheLine = compose(
    { ...role, thresholds: { interview: 1, maybe: 0.5 } },
    questions,
    { ...strong, food_sector_depth: score(1, 4, 0.31) },
    id,
  );
  assert.ok(onTheLine.needsHumanReview);
  assert.match(onTheLine.reviewReasons.join(" "), /sits on the line/);

  const borderline = run({ ...strong, food_sector_present: noul(0.52) });
  assert.ok(borderline.needsHumanReview);
  assert.match(borderline.reviewReasons.join(" "), /borderline/);

  // A decisive evidence-quality flag still routes to a human. A coin-flip one does not.
  const weakEvidence = run({ ...strong, evidence_quality_flag: noul(0.8) });
  assert.match(weakEvidence.reviewReasons.join(" "), /weak or contradictory evidence/);
  const mildDoubt = run({ ...strong, evidence_quality_flag: noul(0.59) });
  assert.ok(!mildDoubt.reviewReasons.some((x) => /weak or contradictory/.test(x)));
  assert.match(mildDoubt.notes.join(" "), /some doubt/);
});

test("a partial response degrades safely instead of throwing", () => {
  const r = run({ experience_determinable: noul(0.9) } as Answers);
  assert.equal(r.dimensions.length, 6);
  assert.ok(r.needsHumanReview);
  assert.match(r.reviewReasons.join(" "), /missing from the response/);
  assert.ok(r.composite >= 0 && r.composite <= 1);
});

test("composite is always within 0..1 and contributions sum to it", () => {
  for (const a of [strong, weak]) {
    const r = run(a);
    assert.ok(r.composite >= 0 && r.composite <= 1, `composite ${r.composite}`);
    if (!r.capped) {
      const sum = r.dimensions.reduce((s, d) => s + d.contribution, 0);
      assert.ok(Math.abs(sum - r.rawComposite) < 1e-3, `${sum} vs ${r.rawComposite}`);
    }
  }
});

test("scoreNorm and topLevel agree on the underlying position", () => {
  const s = score(0.75);
  assert.ok(Math.abs(scoreNorm(s, 4) - 0.75) < 1e-9);
  const top = topLevel(s, (questions.food_sector_depth as any).criteria);
  assert.equal(top.index, 2);
  assert.match(top.text, /Direct food-sector role/);
});
