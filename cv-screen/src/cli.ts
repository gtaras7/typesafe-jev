#!/usr/bin/env tsx
/**
 * Screen a CV with Jev.
 *
 *   npm run screen -- --fixture cv_b_other
 *   npm run screen -- --cv ~/Downloads/my.pdf --name "X" --email x@y.z
 *   npm run screen -- --fixture cv_b_other --dry      # print the request, no API call
 *   npm run screen -- --fixture cv_b_other --json     # full audit trail as JSON
 *
 * The composite score, the gates, and the recommendation are all computed in
 * compose.ts. Nothing here changes a judgment.
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ENV_LOAD_RESULT as envInfo, ENV_FILE_PATH } from "./env.js";
import { FOOD_INDUSTRY_QA } from "./role-spec.js";
import { buildQuestions } from "./questions.js";
import { buildState, screenCv } from "./screen.js";
import type { ScreenResult } from "./compose.js";

// env.js already loaded the .env on import. Real environment variables win over it,
// so `TYPESAFE_API_KEY=x npm run screen` still overrides the file.
const keySource = !process.env.TYPESAFE_API_KEY
  ? `not found (checked the environment and ${ENV_FILE_PATH})`
  : envInfo.loaded.includes("TYPESAFE_API_KEY")
    ? ENV_FILE_PATH
    : "environment variable";

const HERE = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    cv: { type: "string" },
    fixture: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
    today: { type: "string" },
    json: { type: "boolean", default: false },
    dry: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (values.help || (!values.cv && !values.fixture)) {
  console.log(`Usage:
  screen --fixture <key>        one of the keys in fixtures/cvs.json
  screen --cv <path>            a .txt file, or a PDF (needs pdftotext on PATH)
  --name <name> --email <email> candidate identity for the sheet
  --today YYYY-MM-DD            override the date used for the age judgment
  --dry                         build and print the request, make no API call
  --json                        print the full audit trail`);
  process.exit(values.help ? 0 : 1);
}

const role = FOOD_INDUSTRY_QA;

function loadFixture(key: string): string {
  const f = resolve(HERE, "..", "fixtures", "cvs.json");
  const all = JSON.parse(readFileSync(f, "utf8")) as Record<string, string>;
  const text = all[key];
  if (!text) throw new Error(`no fixture "${key}". Available: ${Object.keys(all).join(", ")}`);
  return text;
}

let cvText: string;
if (values.fixture) {
  cvText = loadFixture(values.fixture);
} else {
  const p = values.cv!.replace(/^~/, process.env.HOME ?? "~");
  if (!/\.(txt|md)$/i.test(p)) {
    throw new Error(
      `read ${p} as plain text only. Extract PDFs first, for example: pdftotext -layout ${p} -`,
    );
  }
  cvText = readFileSync(p, "utf8");
}

const name = values.name ?? values.fixture ?? "Unknown";
const email = values.email ?? "";
const today = values.today ?? new Date().toISOString().slice(0, 10);

if (values.dry) {
  const questions = buildQuestions(role, today);
  console.log(
    JSON.stringify(
      { state: buildState(role, { cvText, name, email }, today), model: "jev-latest", questions },
      null,
      2,
    ),
  );
  console.error(
    `\n[dry run] ${Object.keys(questions).length} questions built, no API call made. ` +
      `Request is what the app POSTs to https://api.typesafe.ai/v1/systemone\n` +
      `          key source: ${keySource}`,
  );
  process.exit(0);
}

let outcome;
try {
  outcome = await screenCv(role, { cvText, name, email }, { today });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  screen failed: ${msg}`);
  console.error(`  key source: ${keySource}`);
  console.error(
    `\n  Put the key in either place:\n` +
      `    echo 'TYPESAFE_API_KEY=your_key' >> ${ENV_FILE_PATH}\n` +
      `    export TYPESAFE_API_KEY=your_key\n` +
      `  Get it from https://console.typesafe.ai/settings/keys\n`,
  );
  process.exit(2);
}
const r = outcome.result;

if (values.json) {
  console.log(JSON.stringify({ role: role.id, model: outcome.model, usage: outcome.usage, result: r }, null, 2));
} else {
  render(r, outcome.usage.input_tokens + outcome.usage.output_tokens, outcome.model);
}

function bar(v: number, width = 12): string {
  const filled = Math.round(v * width);
  return "#".repeat(filled) + ".".repeat(width - filled);
}

function render(r: ScreenResult, tokens: number, model: string) {
  console.log(`\n  ${r.candidate.name}${r.candidate.email ? ` <${r.candidate.email}>` : ""}`);
  console.log(`  role: ${role.title}   model: ${model}   tokens: ${tokens}`);
  console.log("\n  " + "dimension".padEnd(22) + "wt   " + "value".padEnd(16) + "contrib  basis");
  console.log("  " + "-".repeat(100));
  for (const d of r.dimensions) {
    console.log(
      "  " +
        d.label.padEnd(22) +
        d.weight.toFixed(2).padEnd(5) +
        `[${bar(d.value)}]`.padEnd(16) +
        d.contribution.toFixed(3).padEnd(9) +
        d.basis +
        (d.unknown ? "  (unknown)" : ""),
    );
  }
  console.log("  " + "-".repeat(100));
  const capNote = r.capped ? `  (raw ${r.rawComposite.toFixed(3)}, capped)` : "";
  console.log(`  COMPOSITE  ${r.composite.toFixed(3)}${capNote}`);
  console.log(
    `  GATES      education=${r.gates.educationAccepted ? "ok" : "FAIL"}  ` +
      `food_sector=${r.gates.foodSectorPresent ? "ok" : "FAIL"}  ` +
      `stability_red_flag=${r.gates.stabilityRedFlag ? "YES" : "no"}`,
  );
  console.log(
    `  PRIORITY   ${r.priority.flagged ? "YES, RnD" : "no"} (p=${r.priority.probability})` +
      `   =>  ${r.recommendation}`,
  );
  if (r.appliedCaps.length) console.log(`  CAPS       ${r.appliedCaps.join("; ")}`);
  if (r.strengths.length) console.log(`  STRENGTHS  ${r.strengths.join(" | ")}`);
  if (r.gaps.length) console.log(`  GAPS       ${r.gaps.join(" | ")}`);
  console.log(
    `  REVIEW     ${r.needsHumanReview ? "yes: " + r.reviewReasons.join("; ") : "no"}`,
  );
  console.log();
}
