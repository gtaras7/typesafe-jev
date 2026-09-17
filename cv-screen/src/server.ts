/**
 * The local web app for screening CVs with Jev. No dependencies, no build step.
 *
 *   npm run ui            -> http://localhost:8799
 *
 * The API key stays server side. The browser only ever sends CV text and receives
 * scores, so the key never appears in page source or in a network request, which is
 * TypeSafe's own guidance and also means the URL can be handed to someone on this
 * machine without leaking anything.
 *
 * The design idea the whole app rests on: the model is asked for judgments, code does
 * the arithmetic. So a folder of CVs is judged once, and changing a weight, a cap or a
 * threshold re-scores every one of them in milliseconds, with no API calls.
 *
 * Routes
 *   GET    /                     the UI
 *   GET    /api/meta             policy, field library, presets, model, store counts
 *   GET    /api/candidates       every row plus the header stats
 *   GET    /api/candidates/:id   one candidate, with the judgments behind it
 *   POST   /api/screen           screen one CV from pasted text
 *   POST   /api/screen-pdf       screen one CV from an uploaded PDF
 *   POST   /api/batch            start a batch; body may carry the first files
 *   POST   /api/batch/chunk      add files to a running batch
 *   POST   /api/batch/finish     say no more files are coming
 *   POST   /api/batch/scan       screen a folder that is already on this machine
 *   GET    /api/batch/stream     server-sent events: live progress and rows
 *   POST   /api/rescan           re-ask only the CVs missing a new question
 *   GET    /api/policy           the current policy
 *   PUT    /api/policy           save it and re-score everything, for free
 *   DELETE /api/candidates       clear the shortlist
 *   GET    /api/export.csv       the table as a spreadsheet
 *   GET    /api/presets          starting points
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_LOAD_RESULT, ENV_FILE_PATH } from "./env.js";
import { buildQuestions, policyQuestionIds } from "./questions.js";
import { validatePolicy, type Policy } from "./policy.js";
import { loadPolicy, savePolicy, POLICY_PATH } from "./policyfile.js";
import { libraryMeta, libraryField, hydrateLibraryField } from "./fields.js";
import { PRESETS, presetById, presetList, defaultPolicy } from "./presets.js";
import { recomposeAll, missingQuestions } from "./recompose.js";
import { openStore, RunStore } from "./store.js";
import { screenCv } from "./screen.js";
import { rowFromStored, histogram, type ApiRow } from "./rows.js";
import { toCsv } from "./csv.js";
import { costUsd } from "./pricing.js";
import { extractPdfBytes, pythonStatus } from "./pdf.js";
import { Jobs, expandPaths, makeRunner, tasksFromPaths } from "./worker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.PORT ?? 8799);
const MAX_BODY = 96 * 1024 * 1024;

const store = openStore(process.env.JEV_DB);
let policy: Policy = loadPolicy();

const jobs = new Jobs();

const keySource = !process.env.TYPESAFE_API_KEY
  ? `NOT SET (checked the environment and ${ENV_FILE_PATH})`
  : ENV_LOAD_RESULT.loaded.includes("TYPESAFE_API_KEY")
    ? ENV_FILE_PATH
    : "environment variable";

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function text(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("payload too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<any> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("body must be JSON");
  }
}

function staticFile(res: ServerResponse, urlPath: string): boolean {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const full = join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) return false;
  if (!existsSync(full) || !statSync(full).isFile()) return false;
  const type =
    extname(full) === ".html"
      ? "text/html; charset=utf-8"
      : extname(full) === ".json"
        ? "application/json; charset=utf-8"
        : extname(full) === ".css"
          ? "text/css; charset=utf-8"
          : extname(full) === ".js"
            ? "text/javascript; charset=utf-8"
            : "application/octet-stream";
  const body = readFileSync(full);
  res.writeHead(200, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": "no-store" });
  res.end(body);
  return true;
}

/** Columns the table shows, in policy order, so the UI does not have to guess. */
function columnMeta(p: Policy) {
  const core: Array<[string, string, boolean]> = [
    ["experience_years", "Experience", (p.weights.experience_years ?? 0) > 0],
    ["education", "Education", Boolean(p.acceptedEducation.length) || (p.weights.education ?? 0) > 0],
    ["food_sector", "Sector", p.sector.enabled || (p.weights.food_sector ?? 0) > 0],
    ["age_over_28", "Age rule", p.age.enabled && (p.weights.age_over_28 ?? 0) > 0],
    ["military", "Military", p.military.enabled && (p.weights.military ?? 0) > 0],
    ["stability", "Stability", (p.weights.stability ?? 0) > 0],
  ];
  return [
    ...core.filter(([, , on]) => on).map(([id, label]) => ({ id, label, kind: "score", mode: "weight", core: true })),
    ...p.extraFields
      .filter((f) => f.enabled)
      .map((f) => ({ id: f.id, label: f.label, kind: f.kind, mode: f.mode, core: false })),
  ];
}

function statsFor(p: Policy, rows: ApiRow[]) {
  const agg = store.stats();
  return {
    candidates: agg.n,
    interview: agg.interview,
    maybe: agg.maybe,
    pass: agg.pass,
    needsReview: agg.needsReview,
    needsRescan: agg.needsRescan,
    avgMs: agg.avgMs,
    totalMs: agg.totalMs,
    avgTokens: agg.tokensPerCv,
    totalTokens: agg.tokens,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    // Input tokens are the billed side; output tokens are free, so the cost of a whole
    // folder of CVs is a fraction of a dollar and the header can say so.
    costUsd: costUsd(agg.inputTokens),
    costPerCvUsd: agg.n ? costUsd(agg.inputTokens) / agg.n : 0,
    priceNote: "$42 per billion input tokens, output free (docs.typesafe.ai/models)",
    fields: p.extraFields
      .filter((f) => f.enabled)
      .map((f) => histogram(rows, f.id, f.label, f.kind)),
  };
}

/** The policy, plus everything the Settings tab needs to render it as a form. */
function policyPayload(p: Policy) {
  return {
    policy: p,
    issues: validatePolicy(p),
    questions: buildQuestions(p, new Date().toISOString().slice(0, 10)),
    questionIds: policyQuestionIds(p),
    columns: columnMeta(p),
    fieldLibrary: libraryMeta().map((m) => ({
      ...m,
      enabled: p.extraFields.some((f) => f.id === m.id && f.enabled),
      // The whole definition, not just the card text: a client switching a field on has
      // to be able to save a field that can actually be judged.
      definition: libraryField(m.id),
    })),
  };
}

/**
 * A new screening can replace the previous shortlist.
 *
 * The app is built around one comparison at a time: the policy, the weights and the decision
 * lines describe the role being hired for right now, so mixing rows scored under an older policy
 * into the same table quietly corrupts the view. The API keeps this explicit rather than
 * defaulting to destructive, so scripts and the CLI stay additive, and the app asks for it.
 */
function maybeClear(body: any): number {
  if (body?.reset !== true) return 0;
  return store.deleteAll();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    /* ---------------------------------------------------------------- the app */
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      const body = readFileSync(join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }

    /* ------------------------------------------------------------------- meta */
    if (req.method === "GET" && path === "/api/meta") {
      const last = store.all(1)[0];
      const py = await pythonStatus();
      json(res, 200, {
        app: { name: "Jev CV Screening", version: "0.2.0" },
        model: { id: last?.model || null, requested: "jev-latest" },
        hasKey: Boolean(process.env.TYPESAFE_API_KEY),
        keySource,
        policyPath: POLICY_PATH,
        pdfReader: "bin" in py ? py.bin : null,
        pdfReaderError: "error" in py ? py.error : null,
        store: { candidates: store.count(), screened_at: store.newestAt() },
        limits: {
          maxUploadMb: Math.round(MAX_BODY / 1024 / 1024),
          defaultConcurrency: DEFAULT_CONCURRENCY,
          maxConcurrency: MAX_CONCURRENCY,
        },
        pricing: {
          usdPerMillionInputTokens: 42,
          outputFree: true,
          source: "https://docs.typesafe.ai/models.md",
        },
        presets: presetList(),
        ...policyPayload(policy),
      });
      return;
    }

    if (req.method === "GET" && path === "/api/presets") {
      json(res, 200, { presets: PRESETS.map((p) => ({ id: p.id, label: p.label, help: p.help })) });
      return;
    }

    if (req.method === "GET" && path === "/api/policy") {
      json(res, 200, policyPayload(policy));
      return;
    }

    if (req.method === "GET" && path === "/api/field-library") {
      json(res, 200, { fieldLibrary: libraryMeta(), fields: libraryField("career_progression") });
      return;
    }

    /* -------------------------------------------------------------- candidates */
    if (req.method === "GET" && path === "/api/candidates") {
      const rows = store.all().map(rowFromStored);
      json(res, 200, { rows, stats: statsFor(policy, rows), columns: columnMeta(policy) });
      return;
    }

    if (req.method === "GET" && path.startsWith("/api/candidates/")) {
      const id = Number(path.slice("/api/candidates/".length));
      const stored = store.get(id);
      if (!stored) {
        json(res, 404, { error: `no candidate with id ${id}` });
        return;
      }
      const row = rowFromStored(stored);
      const state = JSON.parse(stored.policy_json || "null");
      json(res, 200, {
        row,
        result: JSON.parse(stored.result_json || "{}"),
        answers: JSON.parse(stored.answers_json || "{}"),
        questions: JSON.parse(stored.questions_json || "{}"),
        policyAtTheTime: state,
        usage: { input_tokens: stored.input_tokens, output_tokens: stored.output_tokens },
        model: stored.model,
        elapsedMs: stored.elapsed_ms,
        cvChars: stored.cv_chars,
        cvText: stored.cv_text,
        missingQuestions: missingQuestions(policy, JSON.parse(stored.answers_json || "{}")),
      });
      return;
    }

    if (req.method === "DELETE" && path === "/api/candidates") {
      if (url.searchParams.get("confirm") !== "yes") {
        json(res, 400, { error: "add ?confirm=yes to clear the shortlist" });
        return;
      }
      json(res, 200, { deleted: store.deleteAll() });
      return;
    }

    if (req.method === "GET" && path === "/api/export.csv") {
      const rows = store.all().map(rowFromStored);
      const csv = toCsv(rows, policy);
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="jev-candidates-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Content-Length": Buffer.byteLength(csv),
        "Cache-Control": "no-store",
      });
      res.end(csv);
      return;
    }

    /* ---------------------------------------------------------------- screening */
    if (req.method === "POST" && (path === "/api/screen" || path === "/api/screen-pdf")) {
      if (!process.env.TYPESAFE_API_KEY) {
        json(res, 503, {
          error: `TYPESAFE_API_KEY is not set. Put it in ${ENV_FILE_PATH} and restart, or export it before starting the server.`,
        });
        return;
      }
      const body = await readJson(req);
      const cleared = maybeClear(body);
      let cvText: string = typeof body.cvText === "string" ? body.cvText : "";
      let label = typeof body.fileName === "string" && body.fileName ? body.fileName : "pasted-cv.txt";
      if (path === "/api/screen-pdf") {
        if (typeof body.pdfBase64 !== "string" || !body.pdfBase64) {
          json(res, 400, { error: "pdfBase64 is required" });
          return;
        }
        const b64 = body.pdfBase64.includes(",") ? body.pdfBase64.split(",")[1] : body.pdfBase64;
        cvText = await extractPdfBytes(Buffer.from(b64, "base64"), label);
      }
      if (!cvText.trim()) {
        json(res, 400, { error: "no CV text to judge" });
        return;
      }

      const started = Date.now();
      const outcome = await screenCv(policy, {
        cvText,
        name: typeof body.name === "string" && body.name ? body.name : "Unknown",
        email: typeof body.email === "string" ? body.email : "",
      });
      const elapsed = Date.now() - started;
      const r = outcome.result;
      const sha = RunStore.sha256(Buffer.from(cvText));
      const { id } = store.save({
        policyId: policy.id,
        policy,
        questions: outcome.questions,
        candidateName: r.candidate.name,
        candidateEmail: r.candidate.email,
        sourceFile: label,
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

      json(res, 200, {
        row: rowFromStored(store.get(id)!),
        cleared,
        result: r,
        answers: outcome.answers,
        questions: outcome.questions,
        state: { ...(outcome.state as object), cv_text: `(omitted, ${cvText.length} chars)` },
        usage: outcome.usage,
        model: outcome.model,
        elapsedMs: elapsed,
        cvChars: cvText.length,
      });
      return;
    }

    /* -------------------------------------------------------------------- batch */
    if (req.method === "POST" && path === "/api/batch") {
      if (!process.env.TYPESAFE_API_KEY) {
        json(res, 503, { error: `TYPESAFE_API_KEY is not set (looked in ${ENV_FILE_PATH}).` });
        return;
      }
      const body = await readJson(req);
      const concurrency = clampConcurrency(body.concurrency);
      const cleared = maybeClear(body);
      const job = jobs.create("screen", concurrency, makeRunner(store, policy), 0);
      job.setDeclaredTotal(Number(body.total));
      job.armAutoSeal();
      const files = Array.isArray(body.files) ? body.files : [];
      if (files.length) job.add(files.map(toTask));
      json(res, 200, {
        jobId: job.id,
        concurrency,
        cleared,
        total: files.length || job.total,
        chunking: Number(body.total) > files.length,
      });
      return;
    }

    if (req.method === "POST" && path === "/api/batch/chunk") {
      const body = await readJson(req);
      const job = jobs.get(String(body.jobId ?? ""));
      if (!job) {
        json(res, 404, { error: "no such job" });
        return;
      }
      const files = Array.isArray(body.files) ? body.files : [];
      if (job.isClosed()) {
        // Better a clear refusal than a chunk that never gets screened.
        json(res, 409, { error: "this job already finished", jobId: job.id });
        return;
      }
      job.armAutoSeal();
      job.add(files.map(toTask));
      json(res, 200, { accepted: files.length, queued: job.total, sealed: job.isSealed() });
      return;
    }

    if (req.method === "POST" && path === "/api/batch/finish") {
      const body = await readJson(req);
      const job = jobs.get(String(body.jobId ?? ""));
      if (!job) {
        json(res, 404, { error: "no such job" });
        return;
      }
      job.seal();
      json(res, 200, { ok: true, total: job.total });
      return;
    }

    if (req.method === "POST" && path === "/api/batch/scan") {
      if (!process.env.TYPESAFE_API_KEY) {
        json(res, 503, { error: `TYPESAFE_API_KEY is not set (looked in ${ENV_FILE_PATH}).` });
        return;
      }
      const body = await readJson(req);
      const paths: string[] = Array.isArray(body.paths)
        ? body.paths.map(String)
        : typeof body.path === "string"
          ? [body.path]
          : [];
      const files = expandPaths(paths);
      const cleared = maybeClear(body);
      const job = jobs.create("screen", clampConcurrency(body.concurrency), makeRunner(store, policy), files.length);
      json(res, 200, { jobId: job.id, total: files.length, files: files.length, cleared });

      void (async () => {
        try {
          if (!files.length) {
            job.info("no CV files found at that path");
            job.seal();
            return;
          }
          const { tasks, errors } = await tasksFromPaths(files, (m) => job.info(m));
          for (const e of errors) job.info(`skipped ${e.file}: ${e.error}`);
          job.add(tasks);
          job.seal();
        } catch (err) {
          job.info(`reading failed: ${err instanceof Error ? err.message : String(err)}`);
          job.seal();
        }
      })();
      return;
    }

    if (req.method === "GET" && path === "/api/batch/stream") {
      const job = jobs.get(url.searchParams.get("jobId") ?? "");
      if (!job) {
        json(res, 404, { error: "no such job" });
        return;
      }
      job.attach(res);
      return;
    }

    if (req.method === "GET" && path === "/api/jobs") {
      json(res, 200, { jobs: jobs.list() });
      return;
    }

    /* ------------------------------------------------------------------- rescan */
    if (req.method === "POST" && path === "/api/rescan") {
      if (!process.env.TYPESAFE_API_KEY) {
        json(res, 503, { error: `TYPESAFE_API_KEY is not set (looked in ${ENV_FILE_PATH}).` });
        return;
      }
      const pending = store.pendingRescan();
      const job = jobs.create("rescan", 4, makeRunner(store, policy), pending.length);
      for (const row of pending) {
        // Re-ask only the questions that are missing. The CV text came out of the store,
        // so no PDF has to be read again; a row written before this app existed falls
        // back to the PDF that was kept on disk.
        job.add([
          {
            name: row.source_file,
            text: row.cv_text || undefined,
            path: row.cv_text ? undefined : storedPdfPath(row.file_sha256),
            // Keep the row's identity so the answer replaces the candidate instead of adding
            // a second copy of the same person to the shortlist.
            sha256: row.file_sha256,
          },
        ]);
      }
      job.seal();
      json(res, 200, { jobId: job.id, total: pending.length });
      return;
    }

    /* ------------------------------------------------------------------- policy */
    if (req.method === "PUT" && path === "/api/policy") {
      const body = await readJson(req);
      if (!body || typeof body.policy !== "object" || body.policy === null) {
        json(res, 400, { error: "body must be { policy: {...} }" });
        return;
      }
      const candidate = { ...defaultPolicy(), ...body.policy } as Policy;
      // A client that knows a library field only by its summary is completed from the
      // library rather than rejected: switching a field on must never fail this way.
      candidate.extraFields = (candidate.extraFields ?? []).map(hydrateLibraryField);
      const issues = validatePolicy(candidate);
      if (issues.length) {
        json(res, 400, { error: "Some settings need fixing", issues });
        return;
      }
      policy = candidate;
      savePolicy(policy);

      // The point of the whole design: this re-scores every stored candidate from the
      // judgments already on disk. No API call, no tokens, no waiting.
      const rescored = recomposeAll(store, policy);
      json(res, 200, {
        saved: true,
        savedAt: new Date().toISOString(),
        requiresInference: rescored.requiresInference,
        changed: rescored.changed,
        rescored: { n: rescored.n, ms: rescored.ms, tokens: 0 },
        ...policyPayload(policy),
      });
      return;
    }

    if (req.method === "POST" && path === "/api/policy/preset") {
      const body = await readJson(req);
      const preset = presetById(String(body.id ?? ""));
      if (!preset) {
        json(res, 404, { error: `no preset "${body.id}"` });
        return;
      }
      policy = structuredClone(preset.policy);
      savePolicy(policy);
      const rescored = recomposeAll(store, policy);
      json(res, 200, {
        saved: true,
        preset: preset.id,
        requiresInference: rescored.requiresInference,
        rescored: { n: rescored.n, ms: rescored.ms, tokens: 0 },
        ...policyPayload(policy),
      });
      return;
    }

    json(res, 404, { error: `no route for ${req.method} ${path}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ui] request failed:", message);
    json(res, 500, { error: message });
  }
});

/**
 * TypeSafe publishes 1,200 requests per minute and 250,000 tokens per second for Jev 1.13,
 * with no documented concurrency ceiling. Latency, not the rate limit, is what bounds a
 * folder of CVs, so eight in flight is comfortable and still leaves headroom; the client
 * already backs off on 429.
 */
const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 32;

function clampConcurrency(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(n)));
}

/** The stored PDF for a content hash, if this CV was ever uploaded as a file. */
function storedPdfPath(sha256: string): string | undefined {
  const prefix = sha256.slice(0, 12);
  try {
    const hit = readdirSync(store.pdfDir).find((f) => f.startsWith(prefix));
    return hit ? join(store.pdfDir, hit) : undefined;
  } catch {
    return undefined;
  }
}

function toTask(file: any): { name: string; bytes?: Buffer; text?: string } {
  const name = String(file?.name ?? "cv.pdf");
  if (typeof file?.text === "string" && file.text) return { name, text: file.text };
  if (typeof file?.pdfBase64 === "string" && file.pdfBase64) {
    const b64 = file.pdfBase64.includes(",") ? file.pdfBase64.split(",")[1] : file.pdfBase64;
    return { name, bytes: Buffer.from(b64, "base64") };
  }
  throw new Error(`file "${name}" has neither text nor pdfBase64`);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Jev CV screening  ->  http://localhost:${PORT}`);
  console.log(`  role:   ${policy.roleTitle}`);
  console.log(`  policy: ${POLICY_PATH}`);
  console.log(`  store:  ${store.count()} candidate${store.count() === 1 ? "" : "s"}`);
  console.log(`  key:    ${keySource}`);
  void pythonStatus().then((s) =>
    console.log(`  pdf:    ${"bin" in s ? s.bin : `UNAVAILABLE: ${s.error}`}\n`),
  );
});

export { server, store, jobs };
