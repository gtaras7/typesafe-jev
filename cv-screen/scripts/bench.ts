/**
 * Throughput bench for a folder of CVs, against the app on localhost.
 *
 *   npx tsx scripts/bench.ts --path fixtures/sample-cvs --concurrency 8
 *   npx tsx scripts/bench.ts --path fixtures/sample-cvs --concurrency 16 --extrapolate 300
 *
 * Reports what actually happened: wall time, CVs per minute, the latency distribution,
 * tokens, and what the run cost at Jev's published price. The extrapolation is stated
 * as an extrapolation, not as a measurement.
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "http://localhost:8799" },
    path: { type: "string", default: "fixtures/sample-cvs" },
    concurrency: { type: "string", default: "8" },
    extrapolate: { type: "string", default: "" },
    keep: { type: "boolean", default: false },
  },
});

const BASE = values.base!.replace(/\/$/, "");
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

if (!values.keep) await api("/api/candidates?confirm=yes", { method: "DELETE" });

const started = await api("/api/batch/scan", {
  method: "POST",
  body: JSON.stringify({ path: values.path, concurrency: Number(values.concurrency) }),
});
if (started.status !== 200) {
  console.error(`scan refused: HTTP ${started.status}`, started.body);
  process.exit(1);
}
console.log(
  `\n  benching ${started.body.total} CVs with concurrency ${values.concurrency} from ${values.path}\n`,
);

const latencies: number[] = [];
const tokens: number[] = [];
let done = 0;
let failed = 0;
let failures: Array<{ file: string; error: string }> = [];
const verdicts = { INTERVIEW: 0, MAYBE: 0, PASS: 0 };
let total = started.body.total;
let lastTick = 0;

const res = await fetch(`${BASE}/api/batch/stream?jobId=${started.body.jobId}`);
const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";

for (;;) {
  const { value, done: streamDone } = await reader.read();
  if (streamDone) break;
  buffer += decoder.decode(value, { stream: true });
  let cut = buffer.indexOf("\n\n");
  while (cut >= 0) {
    const chunk = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 2);
    if (chunk.startsWith("data:")) {
      const e = JSON.parse(chunk.slice(5).trim());
      if (e.type === "progress") {
        if (e.row) {
          latencies.push(e.row.elapsedMs);
          tokens.push(e.row.tokens);
          verdicts[e.row.recommendation as keyof typeof verdicts]++;
          done++;
        } else {
          failed++;
        }
        if (done + failed - lastTick >= 10) {
          lastTick = done + failed;
          const elapsed = (Date.now() - new Date(started.body.startedAt ?? Date.now()).getTime()) / 1000;
          console.log(`      ${done + failed}/${total}  ${((done + failed) / Math.max(1, elapsed) * 60).toFixed(0)} CV/min so far`);
        }
      }
      if (e.type === "done") {
        failures = e.errors ?? [];
        total = e.total;
        const inputTokens = tokens.reduce((a, b) => a + b, 0);
        const sorted = [...latencies].sort((a, b) => a - b);
        const perMin = (e.done / Math.max(1, e.wallMs / 1000)) * 60;
        console.log(
          `\n  RESULTS` +
            `\n    screened          ${e.done} of ${total} (${e.failed} failed)` +
            `\n    wall time         ${(e.wallMs / 1000).toFixed(1)} s` +
            `\n    throughput        ${perMin.toFixed(0)} CVs per minute at concurrency ${values.concurrency}` +
            `\n    per-CV latency    ${Math.round(sorted[0] ?? 0)} ms fastest, ${percentile(sorted, 50)} ms median, ${percentile(sorted, 95)} ms p95` +
            `\n    tokens            ${inputTokens} input (${Math.round(inputTokens / Math.max(1, e.done))} per CV)` +
            `\n    cost              $${(inputTokens * USD_PER_INPUT_TOKEN).toFixed(5)} for this folder` +
            `\n    verdicts          ${verdicts.INTERVIEW} ready for interview, ${verdicts.MAYBE} maybe, ${verdicts.PASS} pass` +
            (failures.length ? `\n    problems          ${failures.map((f) => f.file + ": " + f.error).join("; ")}` : ""),
        );

        const target = Number(values.extrapolate);
        if (target > e.done) {
          const minutes = target / perMin;
          const cost = (inputTokens / Math.max(1, e.done)) * target * USD_PER_INPUT_TOKEN;
          console.log(
            `\n  EXTRAPOLATION (measured per-CV cost and this rate, not a measurement)` +
              `\n    ${target} CVs would take about ${minutes < 1 ? `${(minutes * 60).toFixed(0)} seconds` : `${minutes.toFixed(1)} minutes`} at concurrency ${values.concurrency}` +
              `\n    and cost about $${cost.toFixed(4)} in input tokens.`,
          );
        }
        console.log("");
      }
    }
    cut = buffer.indexOf("\n\n");
  }
}
