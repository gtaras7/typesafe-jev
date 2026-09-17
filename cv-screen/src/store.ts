/**
 * Durable store for screening runs.
 *
 * SQLite via node:sqlite (built into Node 22, zero dependencies) and plain files on
 * disk for the CVs. It holds everything needed to answer two questions later:
 *
 *  1. What did the model actually say? (answers_json, plus the questions and the
 *     policy that produced them, so the request can be reconstructed.)
 *  2. Would a different policy have decided differently? (the raw judgments are kept,
 *     so recompose.ts can re-score every candidate without a single API call.)
 *
 * Content-hash dedupe means re-ingesting the same folder is idempotent, which the
 * Sheet-based version could not do (it matched on name).
 *
 * One row per CV. Re-screening a CV under a different policy updates that row rather
 * than adding a second one, because the app is built around a single shortlist.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface StoredRun {
  id: number;
  created_at: string;
  /** The policy in force when this CV was judged. */
  policy_id: string;
  /** The policy the current numbers were last scored with. */
  scored_policy_id: string;
  candidate_name: string;
  candidate_email: string;
  source_file: string;
  file_sha256: string;
  cv_chars: number;
  cv_text: string;
  composite: number;
  raw_composite: number;
  capped: number;
  recommendation: string;
  priority: number;
  priority_p: number;
  education_ok: number;
  food_sector_ok: number;
  stability_red_flag: number;
  needs_review: number;
  /** A question the current policy asks has no answer for this CV. */
  needs_rescan: number;
  review_reasons: string;
  fields_json: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  elapsed_ms: number;
  answers_json: string;
  questions_json: string;
  policy_json: string;
  result_json: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at        TEXT    NOT NULL,
  policy_id         TEXT    NOT NULL DEFAULT '',
  scored_policy_id  TEXT    NOT NULL DEFAULT '',
  candidate_name    TEXT    NOT NULL,
  candidate_email   TEXT    NOT NULL DEFAULT '',
  source_file       TEXT    NOT NULL,
  file_sha256       TEXT    NOT NULL,
  cv_chars          INTEGER NOT NULL DEFAULT 0,
  cv_text           TEXT    NOT NULL DEFAULT '',
  composite         REAL    NOT NULL,
  raw_composite     REAL    NOT NULL,
  capped            INTEGER NOT NULL DEFAULT 0,
  recommendation    TEXT    NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 0,
  priority_p        REAL    NOT NULL DEFAULT 0,
  education_ok      INTEGER NOT NULL DEFAULT 0,
  food_sector_ok    INTEGER NOT NULL DEFAULT 0,
  stability_red_flag INTEGER NOT NULL DEFAULT 0,
  needs_review      INTEGER NOT NULL DEFAULT 0,
  needs_rescan      INTEGER NOT NULL DEFAULT 0,
  review_reasons    TEXT    NOT NULL DEFAULT '',
  fields_json       TEXT    NOT NULL DEFAULT '{}',
  model             TEXT    NOT NULL DEFAULT '',
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  elapsed_ms        INTEGER NOT NULL DEFAULT 0,
  answers_json      TEXT    NOT NULL DEFAULT '{}',
  questions_json    TEXT    NOT NULL DEFAULT '{}',
  policy_json       TEXT    NOT NULL DEFAULT '{}',
  result_json       TEXT    NOT NULL DEFAULT '{}',
  UNIQUE (file_sha256)
);
CREATE INDEX IF NOT EXISTS idx_runs_composite ON runs (composite DESC);
CREATE INDEX IF NOT EXISTS idx_runs_created   ON runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_rescan    ON runs (needs_rescan);
`;

/** Columns added after the first release, with the SQL used to add them. */
const ADDED_COLUMNS: Array<[string, string]> = [
  ["policy_id", "TEXT NOT NULL DEFAULT ''"],
  ["scored_policy_id", "TEXT NOT NULL DEFAULT ''"],
  ["cv_text", "TEXT NOT NULL DEFAULT ''"],
  ["cv_chars", "INTEGER NOT NULL DEFAULT 0"],
  ["needs_rescan", "INTEGER NOT NULL DEFAULT 0"],
  ["fields_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["questions_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["policy_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["priority_p", "REAL NOT NULL DEFAULT 0"],
];

export interface SaveRunInput {
  policyId: string;
  policy: unknown;
  questions: unknown;
  candidateName: string;
  candidateEmail: string;
  sourceFile: string;
  sha256: string;
  cvText: string;
  composite: number;
  rawComposite: number;
  capped: boolean;
  recommendation: string;
  priority: boolean;
  priorityP: number;
  educationOk: boolean;
  foodSectorOk: boolean;
  stabilityRedFlag: boolean;
  needsReview: boolean;
  needsRescan: boolean;
  reviewReasons: string[];
  fields: Record<string, string>;
  model: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  answers: unknown;
  result: unknown;
}

export interface CompositionPatch {
  scoredPolicyId: string;
  composite: number;
  rawComposite: number;
  capped: boolean;
  recommendation: string;
  needsReview: boolean;
  needsRescan: boolean;
  reviewReasons: string[];
  fields: Record<string, string>;
  result: unknown;
}

export class RunStore {
  private db: DatabaseSync;
  readonly pdfDir: string;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    // Deliberately NOT next to the user's own folders. An earlier version kept copies in
    // data/pdfs, which is where the sample CVs live, so every scan added another
    // hash-prefixed copy of every CV into the folder being scanned.
    this.pdfDir = join(dirname(path), "files");
    mkdirSync(this.pdfDir, { recursive: true });
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  /** Bring any earlier database up to the current shape without losing rows. */
  private migrate() {
    const table = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
      .get() as { sql?: string } | undefined;

    if (table?.sql && /UNIQUE\s*\(\s*file_sha256\s*,\s*role_id\s*\)/i.test(table.sql)) {
      // The first release allowed one row per (CV, role). The app now keeps one row per
      // CV, so the table has to be rebuilt. Existing rows are carried over and their
      // policy is recovered below.
      this.db.exec("ALTER TABLE runs RENAME TO runs_old");
      this.db.exec(SCHEMA);
      this.db.exec(`
        INSERT INTO runs (created_at, policy_id, scored_policy_id, candidate_name,
          candidate_email, source_file, file_sha256, cv_chars, composite, raw_composite,
          capped, recommendation, priority, priority_p, education_ok, food_sector_ok,
          stability_red_flag, needs_review, review_reasons, model, input_tokens,
          output_tokens, elapsed_ms, answers_json, result_json)
        SELECT created_at, role_id, role_id, candidate_name, candidate_email, source_file,
          file_sha256, cv_chars, composite, raw_composite, capped, recommendation, priority,
          priority_p, education_ok, food_sector_ok, stability_red_flag, needs_review,
          review_reasons, model, input_tokens, output_tokens, elapsed_ms, answers_json,
          result_json FROM runs_old
      `);
      this.db.exec("DROP TABLE runs_old");
      return;
    }

    this.db.exec(SCHEMA);

    const cols = new Set(
      (this.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    for (const [name, type] of ADDED_COLUMNS) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
    }
  }

  /** Store a CV's bytes on disk, keyed by content hash. Returns the hash and path. */
  putPdf(bytes: Buffer, originalName: string): { sha256: string; path: string } {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const safe = originalName.replace(/[^A-Za-z0-9._-]/g, "_").slice(-60) || "cv.pdf";
    const path = join(this.pdfDir, `${sha256.slice(0, 12)}_${safe}`);
    if (!existsSync(path)) writeFileSync(path, bytes);
    return { sha256, path };
  }

  static sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  findBySha(sha256: string): StoredRun | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE file_sha256 = ?").get(sha256) as unknown as
      | StoredRun
      | undefined;
  }

  /** Insert or update the row for this CV. Returns the row id and whether it existed. */
  save(input: SaveRunInput): { id: number; replaced: boolean } {
    const params = [
      new Date().toISOString(),
      input.policyId,
      input.policyId,
      input.candidateName,
      input.candidateEmail,
      input.sourceFile,
      input.sha256,
      input.cvText.length,
      input.cvText,
      input.composite,
      input.rawComposite,
      input.capped ? 1 : 0,
      input.recommendation,
      input.priority ? 1 : 0,
      input.priorityP,
      input.educationOk ? 1 : 0,
      input.foodSectorOk ? 1 : 0,
      input.stabilityRedFlag ? 1 : 0,
      input.needsReview ? 1 : 0,
      input.needsRescan ? 1 : 0,
      input.reviewReasons.join("; "),
      JSON.stringify(input.fields),
      input.model,
      input.inputTokens,
      input.outputTokens,
      input.elapsedMs,
      JSON.stringify(input.answers),
      JSON.stringify(input.questions),
      JSON.stringify(input.policy),
      JSON.stringify(input.result),
    ] as (string | number)[];

    const existing = this.findBySha(input.sha256);
    if (existing) {
      this.db
        .prepare(
          `UPDATE runs SET created_at=?, policy_id=?, scored_policy_id=?, candidate_name=?,
             candidate_email=?, source_file=?, file_sha256=?, cv_chars=?, cv_text=?,
             composite=?, raw_composite=?, capped=?, recommendation=?, priority=?, priority_p=?,
             education_ok=?, food_sector_ok=?, stability_red_flag=?, needs_review=?,
             needs_rescan=?, review_reasons=?, fields_json=?, model=?, input_tokens=?,
             output_tokens=?, elapsed_ms=?, answers_json=?, questions_json=?, policy_json=?,
             result_json=? WHERE id=?`,
        )
        .run(...params, existing.id);
      return { id: existing.id, replaced: true };
    }

    this.db
      .prepare(
        `INSERT INTO runs (created_at, policy_id, scored_policy_id, candidate_name,
           candidate_email, source_file, file_sha256, cv_chars, cv_text, composite,
           raw_composite, capped, recommendation, priority, priority_p, education_ok,
           food_sector_ok, stability_red_flag, needs_review, needs_rescan, review_reasons,
           fields_json, model, input_tokens, output_tokens, elapsed_ms, answers_json,
           questions_json, policy_json, result_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(...params);
    const row = this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
    return { id: row.id, replaced: false };
  }

  /**
   * Rewrite only the numbers that depend on policy. The judgments are untouched, which
   * is the entire reason a policy change costs nothing.
   */
  updateComposition(id: number, patch: CompositionPatch) {
    this.db
      .prepare(
        `UPDATE runs SET scored_policy_id=?, composite=?, raw_composite=?, capped=?,
           recommendation=?, needs_review=?, needs_rescan=?, review_reasons=?, fields_json=?,
           result_json=? WHERE id=?`,
      )
      .run(
        patch.scoredPolicyId,
        patch.composite,
        patch.rawComposite,
        patch.capped ? 1 : 0,
        patch.recommendation,
        patch.needsReview ? 1 : 0,
        patch.needsRescan ? 1 : 0,
        patch.reviewReasons.join("; "),
        JSON.stringify(patch.fields),
        JSON.stringify(patch.result),
        id,
      );
  }

  all(limit = 2000): StoredRun[] {
    return this.db
      .prepare("SELECT * FROM runs ORDER BY composite DESC, id ASC LIMIT ?")
      .all(limit) as unknown as StoredRun[];
  }

  get(id: number): StoredRun | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as unknown as
      | StoredRun
      | undefined;
  }

  /** Candidates whose stored answers do not cover the current policy. */
  pendingRescan(): StoredRun[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE needs_rescan = 1 ORDER BY id ASC")
      .all() as unknown as StoredRun[];
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
    return row.n;
  }

  newestAt(): string | null {
    const row = this.db.prepare("SELECT MAX(created_at) AS t FROM runs").get() as {
      t: string | null;
    };
    return row.t ?? null;
  }

  deleteAll(): number {
    const n = this.count();
    this.db.exec("DELETE FROM runs");
    return n;
  }

  /** Aggregate token spend and latency, so cost per candidate is not a guess. */
  stats(): {
    n: number;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    tokensPerCv: number;
    avgMs: number;
    interview: number;
    maybe: number;
    pass: number;
    needsReview: number;
    needsRescan: number;
    totalMs: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(input_tokens + output_tokens),0) AS tokens,
                COALESCE(SUM(input_tokens),0) AS input_tokens,
                COALESCE(SUM(output_tokens),0) AS output_tokens,
                COALESCE(SUM(elapsed_ms),0) AS total_ms,
                COALESCE(AVG(elapsed_ms),0) AS ms,
                COALESCE(SUM(recommendation = 'INTERVIEW'),0) AS interview,
                COALESCE(SUM(recommendation = 'MAYBE'),0) AS maybe,
                COALESCE(SUM(recommendation = 'PASS'),0) AS pass,
                COALESCE(SUM(needs_review),0) AS needs_review,
                COALESCE(SUM(needs_rescan),0) AS needs_rescan
         FROM runs`,
      )
      .get() as {
      n: number;
      tokens: number;
      input_tokens: number;
      output_tokens: number;
      total_ms: number;
      ms: number;
      interview: number;
      maybe: number;
      pass: number;
      needs_review: number;
      needs_rescan: number;
    };
    return {
      n: row.n,
      tokens: row.tokens,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      tokensPerCv: row.n ? Math.round(row.tokens / row.n) : 0,
      avgMs: Math.round(row.ms),
      totalMs: row.total_ms,
      interview: row.interview,
      maybe: row.maybe,
      pass: row.pass,
      needsReview: row.needs_review,
      needsRescan: row.needs_rescan,
    };
  }

  close() {
    this.db.close();
  }
}

export function openStore(path?: string): RunStore {
  return new RunStore(path ?? resolve(process.cwd(), "data", "jev.sqlite"));
}

/** Read a stored run back as the shape the report generator expects. */
export function storedToReportRun(run: StoredRun): any {
  return {
    result: JSON.parse(run.result_json),
    answers: JSON.parse(run.answers_json),
    questions: JSON.parse(run.questions_json || "{}"),
    usage: { input_tokens: run.input_tokens, output_tokens: run.output_tokens },
    model: run.model,
    elapsedMs: run.elapsed_ms,
    cvChars: run.cv_chars,
    candidateKey: run.source_file,
  };
}

export function parseJson<T>(text: string, fallback: T): T {
  try {
    const v = JSON.parse(text);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}
