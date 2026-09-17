/**
 * Renders one or more saved screen runs into a single static HTML report.
 *
 *   npx tsx scripts/report.ts out/a.json out/b.json -o out/report.html
 *
 * Use it to share results, or to eyeball the composite breakdown without a terminal.
 * Styling uses the host app's theme variables, so it renders correctly in the chat
 * preview pane and in a normal light or dark browser.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface Run {
  result: any;
  answers: Record<string, any>;
  questions: Record<string, any>;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  elapsedMs: number;
  cvChars: number;
  candidateKey?: string;
  cvPreview?: string;
}

const args = process.argv.slice(2);
const outIdx = args.indexOf("-o");
const outPath = outIdx === -1 ? "out/report.html" : args[outIdx + 1]!;
const storeIdx = args.indexOf("--store");
const storePath = storeIdx === -1 ? undefined : args[storeIdx + 1]!;
const inputs = args.filter(
  (a, i) => a !== "-o" && a !== "--store" && i !== outIdx + 1 && i !== storeIdx + 1,
);

const GRADE = (v: number) => (v >= 0.75 ? "good" : v >= 0.4 ? "warn" : "bad");
const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const QID_FOR_DIM: Record<string, string> = {
  experience_years: "experience_level",
  education: "education",
  food_sector: "food_sector_depth",
  age_over_28: "age_evidence",
  military: "military_status",
  stability: "stability_red_flag",
};

function answerCell(a: any): string {
  if (!a) return `<span class="dim">missing</span>`;
  if (a.type === "noul") return `<b class="mono">${a.noul}</b>`;
  if (a.type === "choice") {
    const probs = Object.entries(a.probabilities)
      .sort((x: any, y: any) => y[1] - x[1])
      .map(([o, v]) => `${esc(o)} <span class="mono">${v}</span>`)
      .join(" &middot; ");
    return `<b>${esc(a.choice)}</b><div class="sub">${probs}</div><div class="sub">confidence <span class="mono">${a.confidence}</span></div>`;
  }
  const ladder = Object.entries(a.probabilities)
    .sort((x: any, y: any) => Number(x[0]) - Number(y[0]))
    .map(([l, v]) => `${l}:<span class="mono">${v}</span>`)
    .join(" ");
  return `<b class="mono">${a.score.toFixed(3)}</b><div class="sub">levels ${ladder}</div><div class="sub">confidence <span class="mono">${a.confidence}</span></div>`;
}

function card(run: Run): string {
  const r = run.result;
  const tokens = (run.usage?.input_tokens ?? 0) + (run.usage?.output_tokens ?? 0);

  const dims = r.dimensions
    .map((d: any) => {
      const qid: string | undefined = QID_FOR_DIM[d.id];
      const q = qid ? run.questions?.[qid] : undefined;
      return `<tr>
        <td><b>${esc(d.label)}</b>${d.unknown ? ` <span class="dim">unknown</span>` : ""}<div class="sub">${esc(d.basis)}</div></td>
        <td class="num mono">${d.weight.toFixed(2)}</td>
        <td><div class="bar"><div class="fill ${GRADE(d.value)}" style="width:${(d.value * 100).toFixed(1)}%"></div></div></td>
        <td class="num mono">${d.value.toFixed(2)}</td>
        <td class="num mono">${d.contribution.toFixed(3)}</td>
        <td class="sub">${q ? `<span class="mono">${q.type}</span> ${esc(String(q.instructions).slice(0, 130))}${String(q.instructions).length > 130 ? "&hellip;" : ""}` : ""}</td>
      </tr>`;
    })
    .join("");

  return `<section class="card">
    <div class="head">
      <div>
        <div class="who">${esc(r.candidate.name)}${r.candidate.email ? ` <span class="dim">&lt;${esc(r.candidate.email)}&gt;</span>` : ""}</div>
        <div class="big mono">${r.composite.toFixed(3)}</div>
        <div class="sub">${r.capped ? `raw ${r.rawComposite.toFixed(3)}, capped` : `raw ${r.rawComposite.toFixed(3)}`}
          &middot; ${run.cvChars} CV chars &middot; ${tokens} tokens &middot; ${run.elapsedMs} ms</div>
      </div>
      <div class="badge ${r.recommendation}">${r.recommendation}</div>
    </div>

    <div class="gates">
      <span class="gate ${r.gates.educationAccepted ? "ok" : "fail"}">education ${r.gates.educationAccepted ? "ok" : "FAIL"}</span>
      <span class="gate ${r.gates.foodSectorPresent ? "ok" : "fail"}">food sector ${r.gates.foodSectorPresent ? "ok" : "FAIL"}</span>
      <span class="gate ${r.gates.stabilityRedFlag ? "fail" : "ok"}">stability red flag ${r.gates.stabilityRedFlag ? "YES" : "no"}</span>
      <span class="gate ${r.priority.flagged ? "ok" : ""}">RnD priority ${r.priority.flagged ? "YES" : "no"} <span class="mono">p=${r.priority.probability}</span></span>
      ${r.needsHumanReview ? `<span class="gate fail">human review</span>` : `<span class="gate ok">no review needed</span>`}
    </div>

    ${r.appliedCaps.length ? `<div class="note">caps applied: ${esc(r.appliedCaps.join("; "))}</div>` : ""}
    ${r.needsHumanReview ? `<div class="note">review reasons: ${esc(r.reviewReasons.join("; "))}</div>` : ""}

    <table>
      <thead><tr><th>dimension</th><th class="num">wt</th><th></th><th class="num">value</th><th class="num">contrib</th><th>judgment asked</th></tr></thead>
      <tbody>${dims}</tbody>
    </table>

    <div class="cols">
      <div><h4>Strengths</h4>${r.strengths.length ? r.strengths.map((s: string) => `<div class="li">${esc(s)}</div>`).join("") : `<div class="dim">none</div>`}</div>
      <div><h4>Gaps</h4>${r.gaps.length ? r.gaps.map((s: string) => `<div class="li">${esc(s)}</div>`).join("") : `<div class="dim">none</div>`}</div>
    </div>

    <h4>Raw judgments (${Object.keys(run.answers).length} questions, one request)</h4>
    <table class="raw"><tbody>
      ${Object.entries(run.answers)
        .map(([k, a]) => `<tr><td class="mono qid">${esc(k)}</td><td>${answerCell(a)}</td></tr>`)
        .join("")}
    </tbody></table>

    <details><summary>Explanation built in code, no LLM prose</summary><div class="li" style="margin-top:6px">${esc(r.explanation)}</div></details>
  </section>`;
}

const runs = inputs.map((p) => JSON.parse(readFileSync(resolve(p), "utf8")) as Run);

// --store: render straight from the SQLite run log instead of JSON files.
if (runs.length === 0 && storePath !== undefined) {
  const { openStore, storedToReportRun } = await import("../src/store.js");
  const { buildQuestions } = await import("../src/questions.js");
  const { FOOD_INDUSTRY_QA: role } = await import("../src/role-spec.js");
  const questions = buildQuestions(role, new Date().toISOString().slice(0, 10));
  const store = openStore(storePath);
  for (const row of store.all()) {
    const run = storedToReportRun(row);
    run.questions = questions;
    runs.push(run as Run);
  }
  store.close();
  console.log(`loaded ${runs.length} runs from ${storePath}`);
}
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Jev CV screening report</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--foreground); font: 14.5px/1.5 inherit; background: transparent; }
  h4 { margin: 18px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted-foreground); font-weight: 600; }
  .card { border: 1px solid var(--border); background: var(--card); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  .head { display: flex; align-items: flex-start; gap: 16px; }
  .who { font-size: 15px; font-weight: 600; }
  .big { font-size: 38px; font-weight: 700; letter-spacing: -.02em; line-height: 1.1; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .sub { color: var(--muted-foreground); font-size: 12px; margin-top: 2px; }
  .dim { color: var(--muted-foreground); }
  .badge { margin-left: auto; font-weight: 700; font-size: 12px; letter-spacing: .05em; padding: 6px 12px; border-radius: 999px; white-space: nowrap; }
  .badge.INTERVIEW { background: #123528; color: #3ecf8e; border: 1px solid #245c40; }
  .badge.MAYBE { background: #38301a; color: #f5c451; border: 1px solid #6b5a2a; }
  .badge.PASS { background: #3a1f1f; color: #ff6b6b; border: 1px solid #6e3838; }
  .gates { display: flex; gap: 7px; flex-wrap: wrap; margin: 14px 0; }
  .gate { font-size: 11.5px; font-family: ui-monospace, Menlo, monospace; padding: 4px 9px; border-radius: 6px; border: 1px solid var(--border); }
  .gate.ok { color: #3ecf8e; border-color: #245c40; }
  .gate.fail { color: #ff6b6b; border-color: #6e3838; }
  .note { border-left: 3px solid #f5c451; background: color-mix(in srgb, #f5c451 10%, transparent); padding: 8px 12px; border-radius: 0 7px 7px 0; margin: 10px 0; font-size: 12.5px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--muted-foreground); font-weight: 500; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; padding: 4px 8px 7px 0; border-bottom: 1px solid var(--border); }
  td { padding: 8px 8px 8px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); vertical-align: top; }
  td.num { text-align: right; white-space: nowrap; font-size: 12.5px; }
  .bar { width: 78px; height: 7px; border-radius: 4px; background: color-mix(in srgb, var(--border) 80%, transparent); overflow: hidden; margin-top: 5px; }
  .fill { height: 100%; border-radius: 4px; }
  .fill.good { background: #3ecf8e; } .fill.warn { background: #f5c451; } .fill.bad { background: #ff6b6b; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  @media (max-width: 720px) { .cols { grid-template-columns: 1fr; } }
  .li { font-size: 12.5px; padding: 2px 0; }
  .raw { font-size: 12px; }
  .qid { color: var(--muted-foreground); white-space: nowrap; padding-right: 14px; }
  summary { cursor: pointer; color: var(--muted-foreground); font-size: 12px; margin-top: 12px; }
</style></head>
<body>
${runs.map(card).join("\n")}
</body></html>
`;

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(resolve(outPath), html);
console.log(`wrote ${resolve(outPath)}  (${runs.length} run${runs.length === 1 ? "" : "s"}, ${(html.length / 1024).toFixed(1)} KB)`);