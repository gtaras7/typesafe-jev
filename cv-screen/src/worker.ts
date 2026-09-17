/**
 * The batch worker: a folder of 300 CVs, a live progress stream, and one row per
 * candidate as it lands.
 *
 * A job is a queue plus a small pool. Nothing is buffered to the end, because a
 * recruiter watching 300 CVs wants to see the first shortlist entry after three
 * seconds, not after four minutes, and a failure on CV 104 must not lose the 103 that
 * already worked.
 *
 * The server-sent-events stream is deliberately dumb: one JSON object per line, so the
 * browser can render progress with twenty lines of code and no library.
 */

import type { ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { RunStore } from "./store.js";
import { screenCv } from "./screen.js";
import { bestName, emailFromText, extractAny, extractPdfFile, extractPdfFiles } from "./pdf.js";
import { rowFromStored, type ApiRow } from "./rows.js";
import type { Policy } from "./policy.js";

export interface Task {
  /** Display name, usually the file name. */
  name: string;
  bytes?: Buffer;
  text?: string;
  path?: string;
  /**
   * The row this CV already owns, when the CV is being asked again rather than seen for the
   * first time. Without it a re-ask hashes the stored text, gets a hash that matches no row,
   * and inserts a duplicate of a candidate who is already on the shortlist.
   */
  sha256?: string;
}

/** The shared state-plus-questions budget is ~32k tokens, about 150k characters. */
export const MAX_CV_CHARS = 120_000;

export type Runner = (task: Task) => Promise<ApiRow>;

export interface JobSnapshot {
  jobId: string;
  kind: "screen" | "rescan";
  total: number;
  done: number;
  failed: number;
  concurrency: number;
  startedAt: string;
  finished: boolean;
  tokens: number;
  current: string;
  averageMs: number;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export class Job {
  readonly startedAt = Date.now();
  total: number;
  done = 0;
  failed = 0;
  tokens = 0;
  current = "";
  finished = false;
  readonly latencies: number[] = [];
  readonly errors: Array<{ file: string; error: string }> = [];

  private queue: Task[] = [];
  private inflight = 0;
  private sealed = false;
  private received = 0;
  private declaredTotal = 0;
  private autoSealTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly subs = new Set<ServerResponse>();
  private readonly emitter: Array<(event: unknown) => void> = [];
  private lastProgress: unknown = null;
  private doneEvent: unknown = null;

  constructor(
    readonly id: string,
    readonly kind: "screen" | "rescan",
    readonly concurrency: number,
    private readonly runner: Runner,
    total = 0,
  ) {
    this.total = total;
  }

  snapshot(): JobSnapshot {
    return {
      jobId: this.id,
      kind: this.kind,
      total: this.total,
      done: this.done,
      failed: this.failed,
      concurrency: this.concurrency,
      startedAt: new Date(this.startedAt).toISOString(),
      finished: this.finished,
      tokens: this.tokens,
      current: this.current,
      averageMs: average(this.latencies),
    };
  }

  onEvent(fn: (event: unknown) => void) {
    this.emitter.push(fn);
  }

  add(tasks: Task[]) {
    if (!tasks.length) return;
    // A chunk arriving after the fallback timer fired must not be silently dropped: reopen
    // the job rather than lose the uploader's tail. A finished job is genuinely closed.
    if (this.sealed && !this.finished) this.sealed = false;
    this.queue.push(...tasks);
    this.received += tasks.length;
    this.total = Math.max(this.total, this.done + this.failed + this.queue.length + this.inflight);
    this.pump();
    // The client told us how many files it is sending, so we know when it is done without
    // guessing. This is the primary seal; the timer below is only for clients that did not.
    if (this.declaredTotal > 0 && this.received >= this.declaredTotal) this.seal();
  }

  /** How many files the client says it will send. Zero means it did not say. */
  setDeclaredTotal(n: number) {
    this.declaredTotal = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    if (this.declaredTotal > 0) this.total = this.declaredTotal;
    if (this.declaredTotal > 0 && this.received >= this.declaredTotal) this.seal();
  }

  /** True once the job has finished, so a late upload can be told plainly. */
  isClosed() {
    return this.finished;
  }

  /** True once no more tasks are expected. */
  isSealed() {
    return this.sealed || this.finished;
  }

  /**
   * Fallback only. When the client declares how many files it is sending, the job seals
   * itself as soon as they have all arrived, so the gap between chunks can be as long as the
   * uploader needs (reading and encoding a folder of PDFs is not instant, and a timer short
   * enough to be snappy would cut the tail off a slow upload).
   */
  armAutoSeal(ms = 1500) {
    if (this.declaredTotal > 0) return;
    if (this.autoSealTimer) clearTimeout(this.autoSealTimer);
    this.autoSealTimer = setTimeout(() => {
      if (!this.finished) this.seal();
    }, ms);
    this.autoSealTimer.unref?.();
  }

  /** No more tasks will arrive. The job finishes when the queue drains. */
  seal() {
    this.sealed = true;
    if (this.autoSealTimer) {
      clearTimeout(this.autoSealTimer);
      this.autoSealTimer = null;
    }
    this.pump();
  }

  info(message: string) {
    this.send({ type: "info", jobId: this.id, message });
  }

  /** Attach an SSE response and replay the state it missed. */
  attach(res: ServerResponse) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.subs.add(res);
    const write = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    write({
      type: "job",
      jobId: this.id,
      kind: this.kind,
      total: this.total,
      concurrency: this.concurrency,
      startedAt: new Date(this.startedAt).toISOString(),
    });
    if (this.lastProgress) write(this.lastProgress);
    if (this.doneEvent) {
      write(this.doneEvent);
      res.end();
      this.subs.delete(res);
      return;
    }
    res.on("close", () => this.subs.delete(res));
  }

  private send(event: unknown) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.subs) {
      try {
        res.write(line);
      } catch {
        this.subs.delete(res);
      }
    }
    for (const fn of this.emitter) fn(event);
  }

  private pump() {
    while (!this.finished && this.inflight < this.concurrency && this.queue.length) {
      const task = this.queue.shift()!;
      this.inflight++;
      this.current = task.name;
      void this.runOne(task);
    }
    if (!this.finished && this.sealed && !this.queue.length && this.inflight === 0) this.finish();
  }

  private async runOne(task: Task) {
    try {
      const row = await this.runner(task);
      this.done++;
      this.tokens += row.tokens;
      this.latencies.push(row.elapsedMs);
      this.lastProgress = {
        type: "progress",
        jobId: this.id,
        done: this.done,
        failed: this.failed,
        total: this.total,
        tokens: this.tokens,
        // `ms` is wall time since the run started, which is what "how quick was this run"
        // means. averageMs stays the mean per-CV latency; the header needs both.
        ms: Date.now() - this.startedAt,
        current: task.name,
        averageMs: average(this.latencies),
        row,
      };
      this.send(this.lastProgress);
    } catch (err) {
      this.failed++;
      const message = err instanceof Error ? err.message : String(err);
      this.errors.push({ file: task.name, error: message });
      this.send({
        type: "progress",
        jobId: this.id,
        done: this.done,
        failed: this.failed,
        total: this.total,
        tokens: this.tokens,
        ms: Date.now() - this.startedAt,
        averageMs: average(this.latencies),
        current: task.name,
        error: message,
        row: null,
      });
    } finally {
      this.inflight--;
      this.pump();
    }
  }

  private finish() {
    this.finished = true;
    this.current = "";
    if (this.autoSealTimer) {
      clearTimeout(this.autoSealTimer);
      this.autoSealTimer = null;
    }
    this.doneEvent = {
      type: "done",
      jobId: this.id,
      kind: this.kind,
      done: this.done,
      failed: this.failed,
      total: this.total,
      wallMs: Date.now() - this.startedAt,
      tokens: this.tokens,
      averageMs: average(this.latencies),
      errors: this.errors,
    };
    this.send(this.doneEvent);
    for (const res of this.subs) {
      try {
        res.end();
      } catch {
        /* the client is already gone */
      }
    }
    this.subs.clear();
  }
}

export class Jobs {
  private readonly map = new Map<string, Job>();
  private counter = 0;

  create(kind: "screen" | "rescan", concurrency: number, runner: Runner, total = 0): Job {
    const id = `${kind === "rescan" ? "r" : "b"}_${(++this.counter).toString(36)}${Date.now().toString(36).slice(-4)}`;
    const job = new Job(id, kind, concurrency, runner, total);
    this.map.set(id, job);
    this.sweep();
    return job;
  }

  get(id: string): Job | undefined {
    return this.map.get(id);
  }

  list(): JobSnapshot[] {
    return [...this.map.values()].map((j) => j.snapshot());
  }

  /** Finished jobs are kept for a while so a reconnecting tab can still see the end. */
  private sweep() {
    const cutoff = Date.now() - 15 * 60_000;
    for (const [id, job] of this.map) {
      if (job.finished && job.startedAt < cutoff) this.map.delete(id);
    }
  }
}

/** Files under a path: a single file, or every CV in a folder (and its subfolders). */
export function expandPaths(paths: string[], maxDepth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
        continue;
      }
      if (/\.(pdf|txt|md)$/i.test(entry)) out.push(full);
    }
  };
  for (const raw of paths) {
    const p = raw.replace(/^~/, process.env.HOME ?? "~");
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, 0);
    else out.push(p);
  }
  return out.sort();
}

export interface RunnerOptions {
  /** Report how many files are being read before the judgments start. */
  onReadProgress?: (message: string) => void;
}

/**
 * The runner both the upload path and the folder path use. It reads text, asks Jev,
 * stores the run, and hands back the row the table shows.
 *
 * Extraction is batched when it can be (a folder on disk), because 300 python startups
 * cost more wall time than the judgments themselves.
 */
export function makeRunner(store: RunStore, policy: Policy) {
  return async function run(task: Task): Promise<ApiRow> {
    let cvText = task.text ?? "";
    let bytes: Buffer | undefined = task.bytes;

    // A folder scan carries the extracted text, but the file itself is still on disk.
    // Reading it back is what keeps one CV's identity stable: the content hash of the
    // PDF, not of its text, so scanning a folder twice updates the same rows instead of
    // creating a second copy of everyone.
    if (!bytes && task.path && /\.pdf$/i.test(task.path)) {
      try {
        bytes = readFileSync(task.path);
      } catch {
        bytes = undefined;
      }
    }

    if (!cvText && task.path) {
      cvText = /\.pdf$/i.test(task.path)
        ? await extractPdfFile(task.path)
        : bytes?.toString("utf8") ?? "";
    } else if (!cvText && bytes) {
      cvText = await extractAny(bytes, task.name);
    }
    if (!cvText.trim()) throw new Error("no text could be read from this file");

    // The state and the questions share a budget of roughly 32,000 tokens, which is about
    // 150,000 characters of English (docs.typesafe.ai/primitives). A portfolio CV can
    // exceed that, and a request that overflows would fail the whole candidate, so the
    // text is capped and the row says so rather than pretending it read everything.
    let truncated = false;
    if (cvText.length > MAX_CV_CHARS) {
      cvText = cvText.slice(0, MAX_CV_CHARS);
      truncated = true;
    }

    // Row identity. A CV read from a file is identified by the hash of its bytes. A re-ask works
    // from text that came back out of the store, and hashing that text would invent a second
    // identity for a candidate who is already on file, so the row adds a second copy of itself.
    // The task carries the known identity instead.
    const sha = task.sha256 ?? (bytes ? RunStore.sha256(bytes) : RunStore.sha256(Buffer.from(cvText, "utf8")));
    if (bytes) store.putPdf(bytes, basename(task.name));

    const name = bestName(task.name, cvText);
    const email = emailFromText(cvText);
    const started = Date.now();
    const outcome = await screenCv(policy, { cvText, name, email });
    const elapsed = Date.now() - started;
    const r = outcome.result;
    if (truncated) {
      r.reviewReasons = [
        ...r.reviewReasons,
        `the CV is longer than the model's document budget, so the last part was not read`,
      ];
      r.needsHumanReview = true;
    }

    const { id } = store.save({
      policyId: policy.id,
      policy,
      questions: outcome.questions,
      candidateName: name,
      candidateEmail: email,
      sourceFile: basename(task.name),
      sha256: sha,
      cvText,
      composite: r.composite,
      rawComposite: r.rawComposite,
      capped: r.capped,
      recommendation: r.recommendation,
      priority: r.priority.flagged,
      priorityP: r.priority.probability,
      educationOk: r.gates.educationAccepted,
      foodSectorOk: r.gates.foodSectorPresent,
      stabilityRedFlag: r.gates.stabilityRedFlag,
      needsReview: r.needsHumanReview,
      needsRescan: r.awaitingRescan,
      reviewReasons: r.reviewReasons,
      fields: r.fields,
      model: outcome.model,
      inputTokens: outcome.usage.input_tokens,
      outputTokens: outcome.usage.output_tokens,
      elapsedMs: elapsed,
      answers: outcome.answers,
      result: r,
    });

    return rowFromStored(store.get(id)!);
  };
}

/**
 * Pre-read a list of files in one python process, then hand the worker tasks that
 * already carry their text. Files that cannot be read come back with their own error
 * instead of stopping the run.
 */
export async function tasksFromPaths(
  paths: string[],
  onProgress?: (message: string) => void,
): Promise<{ tasks: Task[]; errors: Array<{ file: string; error: string }> }> {
  const pdfs = paths.filter((p) => /\.pdf$/i.test(p));
  const others = paths.filter((p) => !/\.pdf$/i.test(p));
  const tasks: Task[] = [];
  const errors: Array<{ file: string; error: string }> = [];

  for (const p of others) {
    try {
      tasks.push({ name: basename(p), text: readFileSync(p, "utf8"), path: p });
    } catch (err) {
      errors.push({ file: basename(p), error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (pdfs.length) {
    onProgress?.(`reading ${pdfs.length} PDF${pdfs.length === 1 ? "" : "s"}`);
    const extracted = await extractPdfFiles(pdfs);
    for (const p of pdfs) {
      const hit = extracted.get(p);
      if (!hit) errors.push({ file: basename(p), error: "no text returned for this file" });
      else if (hit.error) errors.push({ file: basename(p), error: hit.error });
      else if (!hit.text.trim()) errors.push({ file: basename(p), error: "the PDF has no text layer" });
      else tasks.push({ name: basename(p), text: hit.text, path: p });
    }
  }

  return { tasks, errors };
}
