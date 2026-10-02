/**
 * Pre-register the expectation key, and check it later.
 *
 *   npm run freeze-key             write or refresh evals/KEY.sha256
 *   npm run freeze-key -- --check   fail if evals/labels.json no longer matches the record
 *
 * Why this exists: an agreement figure only means something if the key was fixed before
 * the model was called. evals/labels.json is gitignored, because it quotes absolute paths
 * and real people's documents, so the file itself cannot be the proof. The fingerprint in
 * evals/KEY.sha256 is tracked, deliberately machine-independent, and covers exactly what
 * was asked and what each answer was meant to be.
 *
 * The workflow, in order:
 *
 *   1. edit evals/labels.json   (never with a Jev answer open on the screen)
 *   2. npm run freeze-key        then commit evals/KEY.sha256
 *   3. npm run eval              only now call the model
 *
 * If you change a label after step 3, the fingerprint changes, the commit shows it, and
 * the old agreement figure is no longer the current one. That visibility is the point.
 *
 * It also refuses to freeze a scaffold. Any label whose note starts with TODO is treated as
 * an unfilled judgment, because npm run key-scaffold leaves every expected value blank on
 * purpose and a half-finished reading must not be able to look like a fixed one.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLabels } from "../src/eval-compare.js";
import { fingerprintKey, findTodos, parseKeyFile, renderKeyFile } from "../src/key-freeze.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const args = process.argv.slice(2);
const check = args.includes("--check");
const labelsArg = args.find((a) => !a.startsWith("--"));

const labelsPath = labelsArg ? resolve(labelsArg) : join(ROOT, "evals", "labels.json");
const keyPath = join(ROOT, "evals", "KEY.sha256");

if (!existsSync(labelsPath)) {
  console.error(`no labels file at ${labelsPath}`);
  process.exit(1);
}

const labels = loadLabels(labelsPath);
const fp = fingerprintKey(labels);
const today = new Date().toISOString().slice(0, 10);

// A scaffold is not a key. Every label the generator writes carries a TODO note, and this
// refuses to turn one into the pre-registered record, because a frozen key that still has
// unfilled judgments would let a half-finished reading look like a fixed one.
const todos = findTodos(labels);

if (todos.length && !check && !args.includes("--force")) {
  console.error(
    `\n  ${todos.length} of ${fp.labels} labels are still TODO, so this is not a key yet.\n\n` +
      `${todos.slice(0, 8).map((t) => `    ${t}`).join("\n")}` +
      (todos.length > 8 ? `\n    ... and ${todos.length - 8} more` : "") +
      `\n\n  Fill in the expected values by reading the CVs, then remove each TODO note.\n` +
      `  To freeze anyway (which defeats the point), add --force.\n`,
  );
  process.exit(1);
}

if (check) {
  if (!existsSync(keyPath)) {
    console.error(`no frozen key at ${keyPath}. Run: npm run freeze-key`);
    process.exit(1);
  }
  const committed = parseKeyFile(readFileSync(keyPath, "utf8"));
  if (!committed.hash) {
    console.error(`${keyPath} has no "key <sha256>" line`);
    process.exit(1);
  }
  if (committed.hash !== fp.hash) {
    console.error(
      `\n  the labels no longer match the frozen key.\n\n` +
        `  frozen   ${committed.hash}  (${committed.frozen ?? "date unknown"})\n` +
        `  current  ${fp.hash}\n\n` +
        `  Any agreement figure measured against the frozen key describes the OLD labels.\n` +
        `  If the change was deliberate, re-run it with no Jev output open, then\n` +
        `  npm run freeze-key and commit evals/KEY.sha256 so the change is visible.\n`,
    );
    process.exit(1);
  }
  console.log(
    `\n  key matches: ${fp.cvs} CVs, ${fp.determinate} graded labels,` +
      ` ${fp.undetermined} undetermined, frozen ${committed.frozen ?? "date unknown"}\n`,
  );
  process.exit(0);
}

writeFileSync(keyPath, renderKeyFile(fp, today), "utf8");
console.log(
  `\n  wrote ${keyPath}\n` +
    `  key          ${fp.hash}\n` +
    `  cvs          ${fp.cvs}\n` +
    `  labels       ${fp.labels}\n` +
    `  determinate  ${fp.determinate}\n` +
    `  undetermined ${fp.undetermined}\n\n` +
    `  Commit this file BEFORE running npm run eval.\n`,
);
