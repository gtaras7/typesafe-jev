/**
 * The row shape the UI reads. One place, so the table, the detail panel and the CSV
 * export can never disagree about what a candidate is.
 */

import type { StoredRun } from "./store.js";
import { parseJson } from "./store.js";
import type { ScreenResult, DimensionResult } from "./compose.js";
import { costUsd } from "./pricing.js";

export interface ApiRow {
  id: number;
  name: string;
  email: string;
  sourceFile: string;
  createdAt: string;
  /** 0..1 match score after caps. */
  composite: number;
  rawComposite: number;
  capped: boolean;
  appliedCaps: string[];
  recommendation: "INTERVIEW" | "MAYBE" | "PASS";
  needsReview: boolean;
  reviewReasons: string[];
  /** Close calls worth reading, which on their own do not make the row unresolved. */
  notes: string[];
  gates: { educationAccepted: boolean; foodSectorPresent: boolean; stabilityRedFlag: boolean };
  flags: { priority: boolean; priorityP: number };
  dimensions: DimensionResult[];
  fields: Record<string, string>;
  elapsedMs: number;
  tokens: number;
  /** What this one screening cost, at the published Jev price (input only). */
  costUsd: number;
  model: string;
  /** True when a question the current policy asks has no answer for this CV. */
  stale: boolean;
  cvChars: number;
  roleTitle: string;
}

export function rowFromStored(run: StoredRun): ApiRow {
  const result = parseJson<ScreenResult | null>(run.result_json || "null", null);
  const fields = parseJson<Record<string, string>>(run.fields_json || "{}", {});
  return {
    id: run.id,
    name: run.candidate_name,
    email: run.candidate_email,
    sourceFile: run.source_file,
    createdAt: run.created_at,
    composite: run.composite,
    rawComposite: run.raw_composite,
    capped: Boolean(run.capped),
    appliedCaps: result?.appliedCaps ?? [],
    recommendation: (run.recommendation as ApiRow["recommendation"]) ?? "PASS",
    needsReview: Boolean(run.needs_review),
    reviewReasons: run.review_reasons ? run.review_reasons.split("; ") : [],
    notes: result?.notes ?? [],
    gates: {
      educationAccepted: Boolean(run.education_ok),
      foodSectorPresent: Boolean(run.food_sector_ok),
      stabilityRedFlag: Boolean(run.stability_red_flag),
    },
    flags: { priority: Boolean(run.priority), priorityP: run.priority_p },
    dimensions: (result?.dimensions ?? []).map((d) => ({ ...d, answer: d.display ?? d.basis })),
    fields: Object.keys(fields).length ? fields : (result?.fields ?? {}),
    elapsedMs: run.elapsed_ms,
    tokens: run.input_tokens + run.output_tokens,
    costUsd: costUsd(run.input_tokens),
    model: run.model,
    stale: Boolean(run.needs_rescan),
    cvChars: run.cv_chars,
    roleTitle: result?.roleTitle ?? "",
  };
}

export interface Histogram {
  id: string;
  label: string;
  kind: "choice" | "score" | "noul";
  buckets: Array<[string, number]>;
}

/** Distribution of a field's answers across the shortlist, for the header view. */
export function histogram(
  rows: ApiRow[],
  id: string,
  label: string,
  kind: "choice" | "score" | "noul",
): Histogram {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = r.fields[id];
    if (v === undefined) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const buckets = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { id, label, kind, buckets };
}
