/**
 * Live smoke test against a running app. Uses real CVs and the real API, so it costs
 * a few thousand tokens and needs a key.
 *
 *   npm run ui                                   # in one terminal
 *   npx tsx scripts/smoke.ts                     # in another
 *   npx tsx scripts/smoke.ts --path ~/cv-folder  # a bigger folder
 *
 * What it proves, in order:
 *   1. the app boots and reports the policy it will judge with
 *   2. a folder of CVs screens end to end with live progress
 *   3. the shortlist and the CSV export agree with what the stream reported
 *   4. changing the policy re-scores everything with 0 tokens, and the numbers move
 *   5. adding a field marks candidates as needing one more pass instead of inventing
 *      a score for a question that was never asked
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "http://localhost:8799" },
    path: { type: "string", default: "data/sample-cvs" },
    concurrency: { type: "string", default: "8" },
    keep: { type: "boolean", default: false },
  },
});

const BASE = values.base!.replace(/\/$/, "");
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/** Read a server-sent-events stream to the end, calling back per event. */
async function stream(path: string, onEvent: (e: any) => void) {
  const res = await fetch(BASE + path);
  if (!res.body) throw new Error("no stream body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf("\n\n");
    while (cut >= 0) {
      const chunk = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 2);
      if (chunk.startsWith("data:")) onEvent(JSON.parse(chunk.slice(5).trim()));
      cut = buffer.indexOf("\n\n");
    }
  }
}

const started = Date.now();
console.log(`\n  smoke test against ${BASE}\n`);

/* ------------------------------------------------------------------ 0. clean slate */
if (!values.keep) {
  const cleared = await api("/api/candidates?confirm=yes", { method: "DELETE" });
  console.log(`  cleared ${cleared.body.deleted ?? "?"} stored candidates for a clean run\n`);
}

/* ---------------------------------------------------------------- 1. the app */
const meta = await api("/api/meta");
check("app responds", meta.status === 200, `HTTP ${meta.status}`);
if (meta.status !== 200) process.exit(1);
check("API key loaded", meta.body.hasKey === true, meta.body.keySource);
console.log(`        role: ${meta.body.policy.roleTitle}`);
console.log(`        questions: ${meta.body.questionIds.length}, model: ${meta.body.model.id ?? "(none yet)"}`);
console.log(
  `        extra fields on: ${meta.body.policy.extraFields.filter((f: any) => f.enabled).map((f: any) => f.id).join(", ") || "none"}`,
);

/* -------------------------------------------------------------- 2. the batch */
const scan = await api("/api/batch/scan", {
  method: "POST",
  body: JSON.stringify({ path: values.path, concurrency: Number(values.concurrency) }),
});
check("folder scan accepted", scan.status === 200, `HTTP ${scan.status} ${JSON.stringify(scan.body).slice(0, 120)}`);
if (scan.status !== 200) process.exit(1);
console.log(`        ${scan.body.total} file(s) under ${values.path}`);

const rows: any[] = [];
let doneEvent: any = null;
let lastLogged = 0;

await stream(`/api/batch/stream?jobId=${scan.body.jobId}`, (e) => {
  if (e.type === "info") console.log(`        · ${e.message}`);
  if (e.type === "progress") {
    if (e.row) rows.push(e.row);
    if (rows.length - lastLogged >= 1) {
      lastLogged = rows.length;
      const r = e.row;
      console.log(
        `        [${e.done + e.failed}/${e.total}] ${
          r ? `${r.name.slice(0, 30).padEnd(32)} ${r.composite.toFixed(3)}  ${r.recommendation.padEnd(9)} ${r.tokens} tok  ${r.elapsedMs}ms` : `FAILED ${e.current}: ${e.error}`
        }`,
      );
    }
  }
  if (e.type === "done") doneEvent = e;
});

check("batch finished", Boolean(doneEvent), doneEvent ? `${doneEvent.done} screened, ${doneEvent.failed} failed` : "no done event");
if (doneEvent) {
  console.log(
    `        wall ${doneEvent.wallMs} ms · ${doneEvent.tokens} tokens · ${doneEvent.averageMs} ms per CV` +
      ` · ${(doneEvent.done / Math.max(1, doneEvent.wallMs / 1000) * 60).toFixed(1)} CV/min`,
  );
  check("every file produced a row", doneEvent.done + doneEvent.failed === doneEvent.total);
  check("rows streamed as they finished", rows.length === doneEvent.done, `${rows.length} rows`);
  const extra = rows[0]?.fields && Object.keys(rows[0].fields);
  if (extra) console.log(`        extra field answers on the first row: ${JSON.stringify(rows[0].fields)}`);
}

/* --------------------------------------------------- 3. shortlist and export */
const list = await api("/api/candidates");
// The same CV scanned twice updates one row, so compare distinct row ids with what is
// stored rather than counting progress events.
const distinct = new Set(rows.map((r) => r.id)).size;
check("shortlist matches the stream", list.body.rows?.length === distinct, `${distinct} distinct, ${list.body.rows?.length} stored`);
const stats = list.body.stats;
console.log(
  `        interview ${stats.interview} · maybe ${stats.maybe} · pass ${stats.pass} · needs review ${stats.needsReview} · avg ${stats.avgMs} ms · ${stats.totalTokens} tokens`,
);

const csvRes = await fetch(BASE + "/api/export.csv");
const csvBytes = new Uint8Array(await csvRes.arrayBuffer());
const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(csvBytes);
check(
  "csv exports",
  csvRes.status === 200 && csv.length > 50,
  `${csv.length} chars, BOM ${csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf}`,
);
const header = csv.split("\r\n")[0]!.replace(/^\uFEFF/, "");
console.log(`        columns: ${header}`);
check("csv has one row per candidate", csv.trim().split("\r\n").length === distinct + 1);

/* ------------------------------------------- 4. change the policy, pay nothing */
const before = list.body.rows.map((r: any) => [r.name, r.composite, r.recommendation]);
const policy = meta.body.policy;
const tampered = JSON.parse(JSON.stringify(policy));
// make experience matter far less and the sector gate toothless, on purpose
tampered.weights.experience_years = 0.05;
tampered.weights.food_sector = 0.4;
tampered.thresholds.interview = 0.9;

const saved = await api("/api/policy", { method: "PUT", body: JSON.stringify({ policy: tampered }) });
check("policy saved", saved.status === 200, `HTTP ${saved.status} ${JSON.stringify(saved.body).slice(0, 200)}`);
if (saved.status === 200) {
  console.log(
    `        re-scored ${saved.body.rescored.n} candidates in ${saved.body.rescored.ms} ms using ${saved.body.rescored.tokens} tokens`,
  );
  check("re-scoring cost nothing", saved.body.rescored.tokens === 0);
  check("re-scoring was fast", saved.body.rescored.ms < 2000, `${saved.body.rescored.ms} ms`);
  check("no re-inference needed for a weight change", saved.body.requiresInference === 0, `${saved.body.requiresInference} would need it`);
  const after = (await api("/api/candidates")).body.rows.map((r: any) => [r.name, r.composite, r.recommendation]);
  const moved = after.filter((a: any[], i: number) => a[1] !== before[i]?.[1]).length;
  check("the shortlist actually moved", moved > 0, `${moved}/${before.length} scores changed`);
  for (const [i, row] of after.entries()) {
    console.log(`        ${String(row[0]).padEnd(28)} ${before[i]?.[1]?.toFixed(3)} ${before[i]?.[2]?.padEnd(9)} -> ${row[1].toFixed(3)} ${row[2]}`);
  }

  /* ------------------------ 5. adding a field needs the model, and says so */
  const withField = JSON.parse(JSON.stringify(saved.body.policy));
  withField.extraFields.push({
    id: "technical_depth",
    label: "Hands-on depth",
    kind: "score",
    mode: "weight",
    weight: 0.15,
    instructions: "How much did this candidate personally build?",
    criteria: ["nothing", "coursework", "small scoped work", "owns features", "owns a system", "deep specialist"],
    enabled: true,
  });
  const added = await api("/api/policy", { method: "PUT", body: JSON.stringify({ policy: withField }) });
  check("adding a field saved", added.status === 200, `HTTP ${added.status} ${JSON.stringify(added.body).slice(0, 160)}`);
  if (added.status === 200) {
    check("adding a field asks for one more pass", added.body.requiresInference === rows.length, `${added.body.requiresInference} of ${rows.length}`);
    const stale = (await api("/api/candidates")).body.rows.filter((r: any) => r.stale).length;
    check("and no score was invented for it", stale === rows.length, `${stale} rows marked stale`);
  }
}

console.log(`\n  ${failures === 0 ? "all checks passed" : failures + " CHECK(S) FAILED"} in ${Date.now() - started} ms\n`);
process.exit(failures === 0 ? 0 : 1);