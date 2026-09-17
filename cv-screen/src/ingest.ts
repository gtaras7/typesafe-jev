/**
 * Batch ingest from the command line: extract a folder of CVs, screen each with Jev,
 * store the results. The same job the web app does, for a headless run or a cron.
 *
 *   npm run ingest -- ~/Downloads/cvs
 *   npm run ingest -- a.pdf b.pdf --concurrency 2
 *   npm run ingest -- ~/Downloads/cvs --list        # just show what is stored
 *   npm run ingest -- ~/Downloads/cvs --reset       # clear the shortlist first
 *
 * Idempotent: a CV already screened under the current policy is updated, not
 * duplicated, matched on the PDF's content hash rather than its filename. The policy
 * comes from data/policy.json, the same file the Settings tab writes, so the CLI and
 * the app always judge against the same rules.
 */

import { parseArgs } from "node:util";
import { basename } from "node:path";
import { openStore, type StoredRun } from "./store.js";
import { loadPolicy } from "./policyfile.js";
import { expandPaths, makeRunner, tasksFromPaths } from "./worker.js";
import { recomposeAll } from "./recompose.js";
import { rowFromStored } from "./rows.js";

const { values, positionals } = parseArgs({
  options: {
    concurrency: { type: "string", default: "4" },
    store: { type: "string" },
    list: { type: "boolean", default: false },
    reset: { type: "boolean", default: false },
    rescore: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`Usage: ingest <path...> [--concurrency 4] [--store data/jev.sqlite] [--list] [--reset]

  path         a folder of CVs (subfolders are read too), or individual files
  --list       skip screening, print what is already stored
  --reset      clear the stored shortlist before screening
  --rescore    re-score every stored candidate under the current policy, no API calls`);
  process.exit(0);
}

const store = openStore(values.store);
let policy = loadPolicy();

function printRanked(rows: StoredRun[], heading: string) {
  if (!rows.length) {
    console.log(`\n  ${heading}: nothing stored yet.\n`);
    return;
  }
  console.log(`\n  ${heading}\n`);
  console.log(
    "  " +
      "candidate".padEnd(28) +
      "score".padEnd(8) +
      "verdict".padEnd(11) +
      "review",
  );
  console.log("  " + "-".repeat(88));
  for (const r of rows) {
    console.log(
      "  " +
        (r.candidate_name || "?").slice(0, 26).padEnd(28) +
        r.composite.toFixed(3).padEnd(8) +
        r.recommendation.padEnd(11) +
        (r.needs_review ? "yes: " + r.review_reasons.slice(0, 40) : "no"),
    );
  }
}

if (values.rescore || values.list) {
  const rescored = recomposeAll(store, policy);
  printRanked(
    store.all(),
    values.rescore
      ? `Re-scored ${rescored.n} candidates in ${rescored.ms} ms using 0 tokens` +
          (rescored.requiresInference
            ? ` (${rescored.requiresInference} need one more pass with Jev: run without --rescore)`
            : "")
      : "Stored candidates",
  );
  const s = store.stats();
  console.log(`\n  ${s.n} candidates · ${s.tokensPerCv} tokens each · ${s.avgMs} ms average\n`);
  store.close();
  process.exit(0);
}

if (values.reset) {
  const n = store.deleteAll();
  console.log(`\n  cleared ${n} stored candidate${n === 1 ? "" : "s"}\n`);
}

const files = expandPaths(positionals);
if (!files.length) {
  console.error("nothing to ingest. Pass a folder or CV paths. See --help.");
  process.exit(1);
}

if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY is not set. Put it in .env, or export it.");
  process.exit(1);
}

const concurrency = Math.max(1, Number(values.concurrency) || 4);
console.log(
  `\n  ingesting ${files.length} CV${files.length === 1 ? "" : "s"} into ${store.path}` +
    `\n  role: ${policy.roleTitle}   concurrency: ${concurrency}\n`,
);

const { tasks, errors } = await tasksFromPaths(files, (m) => console.log(`  ${m}…`));
for (const e of errors) console.error(`  skipped ${e.file}: ${e.error}`);

const run = makeRunner(store, policy);
let done = 0;
let failed = 0;

const queue = [...tasks];
await Promise.all(
  Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, async () => {
    while (queue.length) {
      const task = queue.shift()!;
      try {
        const row = await run(task);
        done++;
        console.log(
          `  [${String(done + failed).padStart(3)}/${tasks.length}] ${task.name.slice(0, 34).padEnd(36)}` +
            `${row.composite.toFixed(3)}  ${row.recommendation.padEnd(10)}` +
            `${row.stale ? "RESCAN " : row.needsReview ? "REVIEW " : "       "}` +
            `${row.tokens} tok  ${row.elapsedMs}ms`,
        );
      } catch (err) {
        failed++;
        console.error(
          `  [${String(done + failed).padStart(3)}/${tasks.length}] ${task.name.slice(0, 34).padEnd(36)}FAILED: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }),
);

printRanked(store.all(), "Shortlist");
const s = store.stats();
console.log(
  `\n  ${done} screened, ${failed} failed. Store now holds ${s.n} candidates` +
    ` · ${s.tokensPerCv} tokens each · ${s.avgMs} ms average\n`,
);
if (s.needsRescan) {
  console.log(
    `  ${s.needsRescan} candidates are missing a question this policy asks.` +
      ` Run again without --reset to re-ask them.\n`,
  );
}

store.close();
export { rowFromStored, basename };
