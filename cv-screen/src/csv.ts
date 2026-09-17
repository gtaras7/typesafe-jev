/**
 * Spreadsheet export. Plain CSV, opening in Excel, Numbers and Google Sheets with no
 * library and no build step.
 *
 * Two details that matter in practice:
 *  - a UTF-8 byte order mark, without which Excel on Windows turns Greek names into
 *    mojibake. A recruiter reading "Î•Î»Î­Î½Î·" would rightly distrust everything else.
 *  - semicolon or comma, chosen from what the rows actually contain, because some
 *    European Excel builds expect semicolons.
 */

import { CORE_DIMENSIONS, type Policy } from "./policy.js";
import { dimensionLabel } from "./compose.js";
import type { ApiRow } from "./rows.js";

export interface Column {
  key: string;
  label: string;
  get: (row: ApiRow) => string | number;
}

const verdictLabel = (r: ApiRow) =>
  r.recommendation === "INTERVIEW" ? "Ready for interview" : r.recommendation === "MAYBE" ? "Maybe" : "Pass";

/** Columns are built from the policy, so the sheet matches what is on screen. */
export function columnsFor(policy: Policy): Column[] {
  const cols: Column[] = [
    { key: "name", label: "Candidate", get: (r) => r.name },
    { key: "email", label: "Email", get: (r) => r.email },
    { key: "file", label: "File", get: (r) => r.sourceFile },
    { key: "score", label: "Match score", get: (r) => r.composite },
    { key: "verdict", label: "Verdict", get: verdictLabel },
    { key: "review", label: "Needs a person", get: (r) => (r.needsReview ? "yes" : "no") },
  ];

  for (const id of CORE_DIMENSIONS) {
    if ((policy.weights[id] ?? 0) <= 0) continue;
    cols.push({
      key: id,
      label: dimensionLabel(id, policy),
      get: (r) => r.dimensions.find((d) => d.id === id)?.display ?? dimensionText(r, id),
    });
  }

  for (const f of policy.extraFields) {
    if (!f.enabled) continue;
    cols.push({
      key: f.id,
      label: f.label,
      get: (r) => r.fields[f.id] ?? "not asked",
    });
  }

  cols.push(
    { key: "why", label: "Why", get: (r) => r.reviewReasons.join("; ") },
    { key: "reasoning", label: "Reasoning", get: (r) => reasoningsFor(r) },
    { key: "ms", label: "Time (ms)", get: (r) => r.elapsedMs },
    { key: "tokens", label: "Tokens", get: (r) => r.tokens },
    { key: "model", label: "Model", get: (r) => r.model },
  );
  return cols;
}

/** The model's own words for a core dimension, so the sheet is auditable. */
function dimensionText(row: ApiRow, id: string): string {
  const d = row.dimensions.find((x) => x.id === id);
  if (!d) return "not asked";
  return `${d.basis} (${d.value.toFixed(2)})`;
}

function reasoningsFor(row: ApiRow): string {
  return row.dimensions
    .map((d) => `${d.label}: ${d.basis}`)
    .join(" | ");
}

/**
 * Quote a field for CSV. Excel is unforgiving about a stray quote or a newline, so
 * anything that could confuse a parser is quoted and its inner quotes are doubled.
 */
export function csvCell(value: string | number): string {
  const text = String(value ?? "");
  return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: ApiRow[], policy: Policy): string {
  const cols = columnsFor(policy);
  // Some row will contain a semicolon in its reasoning text; pick the separator that
  // keeps the file readable in whichever Excel the user has.
  const sample = rows.slice(0, 25).map((r) => cols.map((c) => String(c.get(r))).join(""));
  const anyComma = sample.some((s) => s.includes(","));
  const sep = anyComma ? ";" : ",";
  const lines = [cols.map((c) => csvCell(c.label)).join(sep)];
  for (const row of rows) lines.push(cols.map((c) => csvCell(c.get(row))).join(sep));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
