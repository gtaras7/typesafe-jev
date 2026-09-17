/**
 * PDF text extraction, shared by the UI, the batch worker, the CLI and the ingest job.
 *
 * Previously this lived twice (server.ts and ingest.ts). It is here now, with a batch
 * mode: a folder of 300 CVs is handed to one python process instead of 300, which used
 * to cost more wall time than the judgments themselves.
 *
 * Jev is a decision model, not a document parser, so what this returns is deliberately
 * raw: the Greek text layer of a real CV comes out with broken characters, and that
 * noise is exactly what the model is being asked to judge.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXTRACTOR = resolve(HERE, "..", "scripts", "pdf_to_text.py");

export class ExtractionError extends Error {
  constructor(message: string, readonly path: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

/**
 * Which python3 to run the extractor with.
 *
 * This cannot just be "python3" from PATH. On this machine PATH resolves to a uv tool
 * python that has no pymupdf, while the Framework python at /usr/local/bin does, and
 * the failure only shows up once a real folder of CVs is being read. So: probe the
 * likely interpreters once, cache the first that can `import fitz`, and say something
 * actionable if none can.
 *
 * Override with JEV_PYTHON=/path/to/python3 when a machine needs something else.
 */
const PYTHON_CANDIDATES = [
  process.env.JEV_PYTHON,
  "/usr/local/bin/python3",
  "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/bin/python3",
  "python3",
].filter((p): p is string => Boolean(p));

function canImportPymupdf(bin: string): Promise<boolean> {
  return new Promise((ok) => {
    let child;
    try {
      child = spawn(bin, ["-c", "import fitz"], { stdio: "ignore" });
    } catch {
      return ok(false);
    }
    child.on("error", () => ok(false));
    child.on("close", (code) => ok(code === 0));
  });
}

let cachedPython: Promise<string> | null = null;

export function pythonWithPymupdf(): Promise<string> {
  if (!cachedPython) {
    cachedPython = (async () => {
      for (const bin of PYTHON_CANDIDATES) {
        if (await canImportPymupdf(bin)) return bin;
      }
      throw new Error(
        "no python3 with pymupdf was found. Install it (python3 -m pip install pymupdf) " +
          "or point JEV_PYTHON at an interpreter that has it.",
      );
    })();
  }
  return cachedPython;
}

/** For the boot log: which interpreter will read PDFs, so a surprise is never silent. */
export async function pythonStatus(): Promise<{ bin: string } | { error: string }> {
  try {
    return { bin: await pythonWithPymupdf() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Extract the text of one PDF file. */
export async function extractPdfFile(path: string): Promise<string> {
  const bin = await pythonWithPymupdf();
  return new Promise((ok, fail) => {
    const py = spawn(bin, [EXTRACTOR, path]);
    let out = "";
    let err = "";
    py.stdout.on("data", (d) => (out += d));
    py.stderr.on("data", (d) => (err += d));
    py.on("error", (e) => fail(new ExtractionError(`could not run ${bin}: ${e.message}`, path)));
    py.on("close", (code) => {
      if (code === 0 && out.trim()) ok(out);
      else fail(new ExtractionError(err.trim() || `pdf extraction failed (exit ${code})`, path));
    });
  });
}

/** Extract the text of a PDF held in memory, by way of a temp file. */
export function extractPdfBytes(buf: Buffer, label = "cv.pdf"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "cvpdf-"));
  const file = join(dir, label.replace(/[^A-Za-z0-9._-]/g, "_") || "cv.pdf");
  writeFileSync(file, buf);
  return extractPdfFile(file).finally(() => rmSync(dir, { recursive: true, force: true }));
}

export interface BatchResult {
  path: string;
  text: string;
  error?: string;
}

/**
 * Extract many PDFs in one python process. Never rejects for a single bad file: the
 * per-file error is reported next to that file, so one unreadable CV cannot take down
 * a run of 300.
 */
export function extractPdfFiles(paths: string[]): Promise<Map<string, BatchResult>> {
  return pythonWithPymupdf().then(
    (bin) =>
      new Promise<Map<string, BatchResult>>((ok, fail) => {
        if (!paths.length) return ok(new Map());
        const py = spawn(bin, [EXTRACTOR, "--batch"]);
        const results = new Map<string, BatchResult>();
        let buffer = "";
        let err = "";

        py.stdout.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed) as BatchResult;
              results.set(parsed.path, parsed);
            } catch {
              // a half-written line will arrive again after the next chunk boundary
            }
          }
        });
        py.stderr.on("data", (d) => (err += d));
        py.on("error", (e) => fail(new Error(`could not run ${bin}: ${e.message}`)));
        py.on("close", (code) => {
          if (code === 0) return ok(results);
          fail(new Error(err.trim() || `batch extraction failed (exit ${code})`));
        });

        for (const p of paths) py.stdin.write(p + "\n");
        py.stdin.end();
      }),
  );
}

/**
 * Extract text from bytes that may or may not be a PDF. Plain text uploads are passed
 * through, which keeps the sample corpus and pasted CVs on the same code path.
 */
export async function extractAny(buf: Buffer, label: string): Promise<string> {
  const looksPdf = buf.subarray(0, 5).toString("latin1") === "%PDF-";
  if (!looksPdf && /\.(txt|md|csv)$/i.test(label)) return buf.toString("utf8");
  return extractPdfBytes(buf, label);
}

/** The candidate's name, from the filename, falling back to the first line of the CV. */
export function nameFromFile(file: string): string {
  const base = file.split("/").pop() ?? file;
  const stem = base
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[_]+/g, " ")
    .replace(/\s*[-–]\s*(cv|resume|curriculum|βιογραφικο).*$/i, "")
    .replace(/\s+(cv|resume|curriculum|βιογραφικο)\s*$/i, "")
    // The content hash the store prefixes to its own copies, and any repeats of it from
    // an earlier folder layout.
    .replace(/^([0-9a-f]{8,14}[\s_-]+)+/i, "")
    .trim();
  if (stem.length >= 3 && !/^(cv|resume|curriculum|doc|scan|img|file|document)\b/i.test(stem)) {
    return stem;
  }
  return "";
}

/** A name for the shortlist row: the filename if it says something, else the CV's own header line. */
export function bestName(fileName: string, cvText: string): string {
  const fromFile = nameFromFile(fileName);
  if (fromFile) return fromFile.slice(0, 80);
  const line = cvText
    .split(/\n| {2,}|\.\s/)
    .map((s) => s.trim())
    // A banner or a section heading is not a person's name. This matters because the
    // fallback is the only thing standing between a folder of "scan001.pdf" and 300 rows
    // all called "CV".
    .filter((s) => !/synthetic|sample|curriculum|βιογραφικ|προσωπικ|personal/i.test(s))
    .find((s) => s.length >= 3 && s.length <= 60 && !/[@\d]/.test(s) && /\p{L}/u.test(s));
  return (line ?? "Unknown").slice(0, 80);
}

/** The first email address in the CV. A regex is exact; a model would only approximate it. */
export function emailFromText(cvText: string): string {
  const m = cvText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0] : "";
}
