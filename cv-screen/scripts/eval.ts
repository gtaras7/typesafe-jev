/**
 * Evaluation harness: how accurate are Jev's per-question judgments on known CVs?
 *
 *   npm run eval                 # all CVs in evals/labels.json
 *   npm run eval -- --json       # machine-readable output
 *   npm run eval -- Nikolaos_Papadopoulos_CV.pdf   # just one
 *   npm run eval -- --verify-labels                 # offline: check quotes + ids only
 *
 * Compares RAW per-question answers against the proposed labels in evals/labels.json.
 * Deliberately says nothing about composite scores, gates or recommendations, because
 * those are policy on top of the judgments and they change independently.
 *
 * Every label must carry a quote that really appears in the source CV. --verify-labels
 * checks that offline, so a fabricated justification cannot survive in the labels file.
 */

import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FOOD_INDUSTRY_QA as role } from "../src/role-spec.js";
import { buildQuestions } from "../src/questions.js";
import { screenCv } from "../src/screen.js";
import {
  buildResults,
  loadLabels,
  summarise,
  verifyLabels,
  type CvLabels,
  type LabelsFile,
} from "../src/eval-compare.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const EXTRACTOR = join(ROOT, "scripts", "pdf_to_text.py");
const FIXTURES = join(ROOT, "fixtures", "cvs.json");

const { values, positionals } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    "verify-labels": { type: "boolean", default: false },
    labels: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`Usage: eval [cv-key ...] [--json] [--verify-labels] [--labels path]

  cv-key           limit to specific CVs from evals/labels.json (default: all)
  --verify-labels  offline only: check ids and quotes against the source CVs, no API calls
  --json           emit JSON instead of a report`);
  process.exit(0);
}

const labelsPath = values.labels ? resolve(values.labels) : join(ROOT, "evals", "labels.json");
if (!existsSync(labelsPath)) {
  console.error(`no labels file at ${labelsPath}`);
  process.exit(1);
}
const labels: LabelsFile = loadLabels(labelsPath);
const today = new Date().toISOString().slice(0, 10);
const questionIds = Object.keys(buildQuestions(role, today));

function fixtureText(key: string): string {
  const all = JSON.parse(readFileSync(FIXTURES, "utf8")) as Record<string, string>;
  const t = all[key];
  if (!t) throw new Error(`no fixture "${key}" in fixtures/cvs.json`);
  return t;
}

function extractPdf(path: string): Promise<string> {
  return new Promise((ok, fail) => {
    const py = spawn("python3", [EXTRACTOR, path]);
    let out = "";
    let err = "";
    py.stdout.on("data", (d) => (out += d));
    py.stderr.on("data", (d) => (err += d));
    py.on("error", (e) => fail(new Error(`python3: ${e.message}`)));
    py.on("close", (code) => {
      if (code === 0 && out.trim()) ok(out);
      else fail(new Error(err.trim() || `extraction failed (exit ${code})`));
    });
  });
}

async function sourceTextOf(cv: CvLabels): Promise<string> {
  if (cv.kind === "fixture") return fixtureText(cv.fixtureKey ?? cv.source);
  if (!cv.path) throw new Error(`${cv.source} has kind "pdf" but no path`);
  if (!existsSync(cv.path)) throw new Error(`missing PDF: ${cv.path}`);
  return extractPdf(cv.path);
}

// ---------------------------------------------------------------------------
// Offline integrity check
// ---------------------------------------------------------------------------
if (values["verify-labels"]) {
  const problems: string[] = [];
  let cvsChecked = 0;
  let quotesChecked = 0;

  for (const [key, cv] of Object.entries(labels.cvs)) {
    let src: string;
    try {
      src = await sourceTextOf(cv);
    } catch (err) {
      problems.push(`${key}: could not read source (${err instanceof Error ? err.message : err})`);
      continue;
    }
    cvsChecked++;
    const { missingQuestions, extraQuestions, missingQuotes } = verifyLabels(
      cv,
      src,
      questionIds,
    );
    quotesChecked += Object.keys(cv.labels).length;
    for (const q of missingQuestions) problems.push(`${key}: no label for question "${q}"`);
    for (const q of extraQuestions) problems.push(`${key}: label "${q}" is not a known question id`);
    for (const q of missingQuotes) {
      problems.push(`${key}: quote for "${q}" does not appear in the source CV: ${JSON.stringify(cv.labels[q]?.quote ?? "")}`);
    }
  }

  console.log(
    `\n  label integrity: ${cvsChecked} CVs, ${quotesChecked} labels, ${questionIds.length} known question ids\n`,
  );
  if (problems.length) {
    for (const p of problems) console.log(`  FAIL  ${p}`);
    console.log(`\n  ${problems.length} problem(s). Fix the labels before trusting any score.\n`);
    process.exit(1);
  }
  console.log("  all labels present, all ids known, every quote found in its source CV\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Live evaluation
// ---------------------------------------------------------------------------
const selected = positionals.length
  ? Object.entries(labels.cvs).filter(([k, cv]) =>
      positionals.includes(k) || positionals.includes(cv.source) || positionals.includes(cv.name ?? ""),
    )
  : Object.entries(labels.cvs);

if (!selected.length) {
  console.error(`no CVs matched ${positionals.join(", ")}. Known keys:\n  ${Object.keys(labels.cvs).join("\n  ")}`);
  process.exit(1);
}

if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY is not set. Put it in .env, or export it.");
  process.exit(1);
}

console.log(
  `\n  evaluating ${selected.length} CV${selected.length === 1 ? "" : "s"} against ${questionIds.length} questions each` +
    `\n  labels: ${labelsPath}` +
    `\n  labels are PROPOSED, not verified ground truth. See evals/README.md.\n`,
);

interface CvReport {
  key: string;
  name: string;
  tokens: number;
  elapsedMs: number;
  summary: ReturnType<typeof summarise>;
  mismatches: Array<{ questionId: string; actual: unknown; expected: unknown; detail: string; quote: string; note?: string }>;
  confidence: Array<{ questionId: string; status: string; detail: string }>;
}

const reports: CvReport[] = [];

for (const [key, cv] of selected) {
  process.stdout.write(`  ${key.padEnd(34)} `);
  try {
    const text = await sourceTextOf(cv);
    const t0 = Date.now();
    const outcome = await screenCv(role, { cvText: text, name: cv.name ?? key, email: "" });
    const elapsed = Date.now() - t0;

    const results = buildResults(outcome.questions, outcome.answers, cv.labels);
    const summary = summarise(results);
    const mismatches = results
      .filter((r) => r.status === "mismatch" || r.status === "missing")
      .map((r) => ({
        questionId: r.questionId,
        actual: r.actual,
        expected: r.expected,
        detail: r.detail,
        quote: r.quote,
        note: r.note,
      }));

    reports.push({
      key,
      name: cv.name ?? key,
      tokens: outcome.usage.input_tokens + outcome.usage.output_tokens,
      elapsedMs: elapsed,
      summary,
      mismatches,
      confidence: results.map((r) => ({ questionId: r.questionId, status: r.status, detail: r.detail })),
    });

    console.log(
      `${summary.matched}/${summary.determinate} agree` +
        `${summary.mismatched ? `  ${summary.mismatched} mismatch` : ""}` +
        `${summary.missing ? `  ${summary.missing} missing` : ""}` +
        `${summary.undetermined ? `  ${summary.undetermined} undetermined` : ""}` +
        `  ${outcome.usage.input_tokens + outcome.usage.output_tokens} tok  ${elapsed}ms`,
    );
  } catch (err) {
    console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
  }
}

const totals = reports.reduce(
  (acc, r) => ({
    matched: acc.matched + r.summary.matched,
    determinate: acc.determinate + r.summary.determinate,
    mismatched: acc.mismatched + r.summary.mismatched,
    missing: acc.missing + r.summary.missing,
    tokens: acc.tokens + r.tokens,
  }),
  { matched: 0, determinate: 0, mismatched: 0, missing: 0, tokens: 0 },
);

if (values.json) {
  console.log(
    JSON.stringify(
      { today, labelsPath, reports, overall: { ...totals, agreement: totals.determinate ? totals.matched / totals.determinate : null } },
      null,
      2,
    ),
  );
} else {
  // which questions are actually reliable?
  const byQuestion = new Map<string, { match: number; mismatch: number; missing: number; undetermined: number }>();
  for (const r of reports) {
    for (const c of r.confidence) {
      const e = byQuestion.get(c.questionId) ?? { match: 0, mismatch: 0, missing: 0, undetermined: 0 };
      e[c.status as "match"]++;
      byQuestion.set(c.questionId, e);
    }
  }

  console.log("\n  per question\n");
  console.log("  " + "question".padEnd(26) + "agree".padEnd(9) + "mismatch".padEnd(10) + "missing".padEnd(9) + "undet.");
  console.log("  " + "-".repeat(66));
  for (const qid of questionIds) {
    const e = byQuestion.get(qid);
    if (!e) continue;
    const determinate = e.match + e.mismatch + e.missing;
    const flag = determinate > 0 && e.mismatch === 0 ? "  ok" : e.mismatch > 0 ? "  <= investigate" : "";
    console.log(
      "  " +
        qid.padEnd(26) +
        `${e.match}/${determinate}`.padEnd(9) +
        String(e.mismatch || "").padEnd(10) +
        String(e.missing || "").padEnd(9) +
        (e.undetermined || "") +
        flag,
    );
  }

  if (reports.some((r) => r.mismatches.length)) {
    console.log("\n  disagreements, with the CV quote each label rested on\n");
    for (const r of reports) {
      if (!r.mismatches.length) continue;
      console.log(`  ${r.name}  (${r.key})`);
      for (const m of r.mismatches) {
        console.log(`    ${m.questionId}`);
        console.log(`      expected ${JSON.stringify(m.expected)}   Jev said ${JSON.stringify(m.actual)}`);
        console.log(`      observed  ${m.detail}`);
        console.log(`      quote     ${JSON.stringify(m.quote)}`);
        if (m.note) console.log(`      note      ${m.note}`);
      }
      console.log("");
    }
  }

  console.log(
    `\n  overall agreement ${totals.matched}/${totals.determinate}` +
      ` = ${totals.determinate ? ((totals.matched / totals.determinate) * 100).toFixed(1) : "n/a"}%` +
      `   ${totals.mismatched} mismatches, ${totals.missing} missing` +
      `   ${totals.tokens} tokens total\n`,
  );
  console.log("  These labels are proposed, not verified. Review evals/labels.json before tuning\n  any threshold on these numbers.\n");
}