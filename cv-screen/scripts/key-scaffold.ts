/**
 * Scaffold a fresh expectation key for the synthetic sample corpus.
 *
 *   npm run key-scaffold                     -> evals/labels.sample-cvs.json
 *   npm run key-scaffold -- --out path.json
 *
 * What it does, and what it deliberately refuses to do.
 *
 * For each of the 40 generated CVs it writes an entry in exactly the shape the eval harness
 * reads, with all ten questions present and a `quote` that is a real verbatim excerpt from
 * that CV, chosen to be the evidence the question is about: the employer block for
 * stability, the birth date for age, the degree line for education, and so on.
 *
 * It does NOT write a single `expected` value. Every label is left as "undetermined" with a
 * TODO note, because the judgment is the part that has to be the project author's reading of
 * the CV, made without a model answer on the screen. A scaffold that guessed would be worse
 * than no scaffold: it would look like a key.
 *
 * `npm run freeze-key` refuses to freeze a key that still has TODOs, so an unfinished
 * scaffold cannot quietly become the pre-registered one.
 *
 * Quotes are sliced out of the whitespace-normalised extracted text, which is what the
 * harness compares against, so they are verbatim by construction. `npm run eval -- --labels
 * <file> --verify-labels` re-checks all of them offline, and is the acceptance test for
 * anything this script produces.
 *
 * The pickers avoid matching Greek words, because the degraded text layer in some CVs
 * mangles them unpredictably (ί becomes I, Δ becomes ∆, µ is the micro sign). What survives
 * reliably is punctuation and Latin text: a job block is always
 * `('<employer>', '<employer>') | <dates>`, a birth date is always dd/mm/yyyy while job
 * dates are only MM/YYYY or YYYY, and a degree line always starts with Πτυχ followed by
 * letters.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FOOD_INDUSTRY_QA as role } from "../src/role-spec.js";
import { buildQuestions, levelText, TODAY_TOKEN } from "../src/questions.js";
import { loadSampleManifest, resolveSamplePath } from "../src/sample-corpus.js";
import type { Question } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const EXTRACTOR = join(ROOT, "scripts", "pdf_to_text.py");
const SAMPLES = join(ROOT, "fixtures", "sample-cvs");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outArg = outIdx >= 0 ? args[outIdx + 1] : undefined;
const outPath = outArg ? resolve(outArg) : join(ROOT, "evals", "labels.sample-cvs.json");

const PYTHON = process.env.JEV_PYTHON ?? "python3";
const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

function extract(path: string): Promise<string> {
  return new Promise((ok, fail) => {
    const py = spawn(PYTHON, [EXTRACTOR, path]);
    let out = "";
    let err = "";
    py.stdout.on("data", (d) => (out += d));
    py.stderr.on("data", (d) => (err += d));
    py.on("error", (e) => fail(new Error(`${PYTHON}: ${e.message}`)));
    py.on("close", (code) => {
      if (code === 0 && out.trim()) ok(out);
      else fail(new Error(err.trim() || `extraction failed (exit ${code})`));
    });
  });
}

// ---------------------------------------------------------------------------
// Evidence pickers
// ---------------------------------------------------------------------------

interface Job {
  /** Index of the employer block in the normalised text, used to slice a quote. */
  at: number;
  title: string;
  employer: string;
  dates: string;
}

/** `('<employer>', '<employer>') | <dates>` survives in every CV, degraded or not. */
export function findJobs(text: string): Job[] {
  const re = /([^•|]{2,70}?)\s*\('([^']*)',\s*'[^']*'\)\s*\|\s*([^•]{0,45})/g;
  const out: Job[] = [];
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const lead = m[1] ?? "";
    out.push({
      at: m.index + lead.length - lead.trimStart().length,
      title: lead.trim(),
      employer: m[2] ?? "",
      dates: (m[3] ?? "").trim(),
    });
    m = re.exec(text);
  }
  return out;
}

interface Evidence {
  quote: string;
  /** False when the picker fell back, which is recorded in the note rather than hidden. */
  specific: boolean;
}

function slice(text: string, from: number, to: number): string {
  return text.slice(Math.max(0, from), Math.min(text.length, to)).trim();
}

/** A window around a match, so the quote reads as evidence rather than as a bare token. */
function around(text: string, at: number, len: number, back: number, fwd: number): string {
  return slice(text, Math.max(0, at - back), at + len + fwd);
}

function search(text: string, re: RegExp): { at: number; text: string } | null {
  const m = new RegExp(re.source, re.flags.replace("g", "")).exec(text);
  return m ? { at: m.index, text: m[0] } : null;
}

const NONE: Evidence = { quote: "", specific: false };

/** "4 years of experience", tolerating the Greek spelling the text layer mangles. */
function pickYears(text: string): Evidence {
  const en = search(text, /\d+\+? years? of experience/i);
  if (en) return { quote: around(text, en.at, en.text.length, 45, 45), specific: true };
  const gr = search(text, /\d+\s+\S{0,12}νια\s+\S{0,12}πειρ/i);
  if (gr) return { quote: around(text, gr.at, gr.text.length, 45, 45), specific: true };
  return NONE;
}

/** A day-precision date is a birth date; job dates are only MM/YYYY or YYYY. */
function pickBirthDate(text: string): Evidence {
  const m = search(text, /\d{2}\/\d{2}\/\d{4}/);
  if (m) return { quote: around(text, m.at, m.text.length, 36, 16), specific: true };
  return NONE;
}

function pickMilitary(text: string): Evidence {
  // The prefix is deliberately short. The degraded text layer rewrites Greek letters as
  // visually similar non-Greek codepoints (omega becomes the Ohm sign, iota and the
  // accented vowels become a Latin I, delta becomes an increment sign), so matching a whole
  // Greek word is hopeless. "Στρατ" survives, and everything after it is quoted as it stands.
  const m =
    search(text, /Military service:[^|]{0,40}/i) ?? search(text, /Στρατ[^|]{0,45}/);
  // Wide context: these lines sit inside the header line, so a tight window slices a
  // neighbouring word in half and the quote stops reading as evidence.
  if (m) return { quote: around(text, m.at, m.text.length, 30, 20), specific: true };
  return NONE;
}

/** The header line: name, title, contact, and any birth date or military line the CV states. */
function pickHeader(text: string): Evidence {
  return { quote: slice(text, 0, 190), specific: false };
}

/**
 * The dated evidence age would have to be inferred from, for a CV with no birth date:
 * a graduation year range, a parenthesised year, or failing that any four-digit year.
 */
function pickYearEvidence(text: string): Evidence {
  const range = search(text, /\b(?:19|20)\d{2}\s*–\s*(?:19|20)\d{2}\b/);
  if (range) return { quote: around(text, range.at, range.text.length, 40, 12), specific: false };
  const paren = search(text, /\((?:19|20)\d{2}\)/);
  if (paren) return { quote: around(text, paren.at, paren.text.length, 45, 12), specific: false };
  const bare = search(text, /\b(?:19|20)\d{2}\b/);
  if (bare) return { quote: around(text, bare.at, bare.text.length, 45, 12), specific: false };
  return NONE;
}

function pickDegree(text: string): Evidence {
  const m =
    search(text, /\b(?:BSc|BA|MSc|MA|PhD|MEng)\b[^•]{5,70}/) ??
    // Πτυχ followed by letters matches Πτυχίο and the degraded ΠτυχIο alike.
    search(text, /Πτυχ\S*[^•]{5,60}/);
  if (m) return { quote: around(text, m.at, m.text.length, 26, 26), specific: true };
  return NONE;
}

function pickPriority(text: string): Evidence {
  const m = search(text, /R&D;?|Research and Development|αν\S{0,2}πτυξ\S*/);
  if (m) return { quote: around(text, m.at, m.text.length, 45, 65), specific: true };
  return NONE;
}

/** Anything that makes the document itself hard to trust. */
function pickInconsistency(text: string, jobs: Job[], referenceDate: string): Evidence {
  const noDates = search(text, /\(no dates[^)]*\)/i);
  if (noDates) return { quote: around(text, noDates.at, noDates.text.length, 45, 24), specific: true };

  // A month written with no year, which the generator emits as "Μάρτιος ?? – Σήμερα".
  const blankYear = search(text, /\?\?/);
  if (blankYear) return { quote: around(text, blankYear.at, blankYear.text.length, 45, 34), specific: true };

  // The same date range twice: two roles claiming the same span.
  const seen = new Map<string, Job>();
  for (const job of jobs) {
    if (!job.dates) continue;
    const prior = seen.get(job.dates);
    if (prior) return { quote: slice(text, prior.at, job.at + job.dates.length + 18), specific: true };
    seen.set(job.dates, job);
  }

  // A role that runs past the corpus reference date.
  const ranges = text.matchAll(/\d{2}\/(\d{4})\s*–\s*\d{2}\/(\d{4})/g);
  const refYear = Number(referenceDate.slice(0, 4));
  for (const r of ranges) {
    if (Number(r[2]) > refYear) {
      return { quote: around(text, r.index, r[0].length, 45, 8), specific: true };
    }
  }

  return NONE;
}

/** The first few employer blocks, which is the evidence a stability judgment rests on. */
function pickEmployerBlocks(text: string, jobs: Job[], blocks: number, tail: number): Evidence {
  const first = jobs[0];
  if (!first) return NONE;
  const last = jobs[Math.min(jobs.length, blocks) - 1];
  if (!last) return NONE;
  return { quote: slice(text, first.at, last.at + last.dates.length + tail), specific: true };
}

type Picker = (text: string, jobs: Job[], referenceDate: string) => Evidence;

const PICKERS: Record<string, Picker> = {
  experience_determinable: (t, jobs) => (pickYears(t).specific ? pickYears(t) : pickEmployerBlocks(t, jobs, 1, 130)),
  experience_level: (t, jobs) => (pickYears(t).specific ? pickYears(t) : pickEmployerBlocks(t, jobs, 1, 130)),
  education: (t) => pickDegree(t),
  food_sector_present: (t, jobs) => pickEmployerBlocks(t, jobs, 1, 110),
  food_sector_depth: (t, jobs) => pickEmployerBlocks(t, jobs, 1, 110),
  age_evidence: (t) => pickBirthDate(t),
  military_status: (t) => pickMilitary(t),
  stability_red_flag: (t, jobs) => pickEmployerBlocks(t, jobs, 3, 120),
  rnd_priority: (t) => pickPriority(t),
  evidence_quality_flag: (t, jobs, ref) => pickInconsistency(t, jobs, ref),
};

/**
 * What to quote when the specific picker found nothing, which is the common case and is
 * usually itself the answer. "No military line anywhere" is the evidence for `not_stated`,
 * and "dates that agree with each other" is the evidence for `false` on the quality flag,
 * so the quote has to be the part of the CV where the missing thing would have been, not a
 * generic excerpt. Each entry says which it is, and the note repeats it to the reader.
 */
const FALLBACKS: Record<string, { pick: Picker; why: string }> = {
  experience_determinable: {
    pick: (t, jobs) => pickEmployerBlocks(t, jobs, 1, 130),
    why: "no explicit duration statement, so the quote is the dated role that has to stand in for one",
  },
  experience_level: {
    pick: (t, jobs) => pickEmployerBlocks(t, jobs, 1, 130),
    why: "no explicit duration statement, so the quote is the dated role the level rests on",
  },
  age_evidence: {
    pick: (t) => pickYearEvidence(t),
    why: "no birth date anywhere, so the quote is the dated evidence age would have to be inferred from",
  },
  military_status: {
    pick: (t) => pickHeader(t),
    why: "no military line found, so the quote is the header where it would appear",
  },
  rnd_priority: {
    pick: (t, jobs) => pickEmployerBlocks(t, jobs, 3, 120),
    why: "no research and development marker found, so the quote is the roles that would have shown one",
  },
  evidence_quality_flag: {
    pick: (t, jobs) => pickEmployerBlocks(t, jobs, 4, 130),
    why: "no inconsistency detected, so the quote is the dated roles the judgment rests on",
  },
};

/** The legal values for a question, taken from the live question map so they cannot drift. */
function legalValues(question: Question): string {
  if (question.type === "noul") return "true | false";
  if (question.type === "choice") return Object.keys(question.criteria ?? {}).join(" | ");
  const levels = question.criteria;
  if (!Array.isArray(levels) || !levels.length) return "level index (no levels defined)";
  return `level index 0..${levels.length - 1} (${levels
    .map((l, i) => `${i}=${levelText(l)}`)
    .join("; ")})`;
}

// ---------------------------------------------------------------------------
// Build it
// ---------------------------------------------------------------------------

const questions = buildQuestions(role, TODAY_TOKEN);
const questionIds = Object.keys(questions);
const manifest = loadSampleManifest(SAMPLES);
const referenceDate = manifest.reference_date ?? new Date().toISOString().slice(0, 10);

const cvs: Record<string, unknown> = {};
const fallbacks: string[] = [];
let labelCount = 0;

for (const entry of manifest.files) {
  const text = normalise(await extract(resolveSamplePath(SAMPLES, entry.file)));
  const jobs = findJobs(text);
  const labels: Record<string, unknown> = {};

  for (const id of questionIds) {
    const question = questions[id];
    if (!question) throw new Error(`question "${id}" vanished from the map`);
    const picker = PICKERS[id];
    if (!picker) throw new Error(`no picker for question "${id}"`);

    let evidence = picker(text, jobs, referenceDate);
    let why = "";

    if (!evidence.quote) {
      // The specific picker found nothing, which is often the answer rather than a failure:
      // "no military line anywhere" is the evidence for not_stated. So quote the part of the
      // CV where the missing thing would have been, and say which it is in the note.
      const fb = FALLBACKS[id];
      const fromFallback = fb ? fb.pick(text, jobs, referenceDate) : NONE;
      evidence = fromFallback.quote ? fromFallback : pickHeader(text);
      why = fb?.why ?? "no specific evidence found, so the quote is the document header";
      fallbacks.push(`${entry.file}/${id}`);
    }

    labelCount++;
    labels[id] = {
      expected: "undetermined",
      quote: evidence.quote,
      note: `TODO: set expected (${legalValues(question)}).${why ? ` ${why}.` : ""}`,
    };
  }

  cvs[entry.file] = {
    kind: "sample",
    source: entry.file,
    file: entry.file,
    note: entry.profile,
    labels,
  };
}

writeFileSync(
  outPath,
  JSON.stringify(
    {
      meta: {
        note:
          "PROPOSED scaffold, NOT a key. Every label starts as undetermined with a TODO note. " +
          "Fill in each expected value by reading the CV, never with a model answer on screen, " +
          "then remove the TODO notes. npm run freeze-key refuses while any TODO remains.",
        derivedOn: new Date().toISOString().slice(0, 10),
        corpus: "fixtures/sample-cvs",
        corpusSeed: manifest.seed,
        generator: manifest.generator,
        questionsPerCv: questionIds.length,
        cvs: manifest.files.length,
        labels: labelCount,
        fallbackQuotes: fallbacks.length,
      },
      cvs,
    },
    null,
    1,
  ),
  "utf8",
);

console.log(
  `\n  wrote ${outPath}\n` +
    `  ${manifest.files.length} CVs x ${questionIds.length} questions = ${labelCount} labels\n` +
    `  every expected value is "undetermined"; each note carries the legal values and starts with TODO\n` +
    (fallbacks.length
      ? `\n  ${fallbacks.length} label(s) had no specific marker, which is usually the evidence for the answer.\n` +
        `  Those notes say which part of the CV was quoted instead. First few:\n` +
        `${fallbacks.slice(0, 6).map((f) => `    ${f}`).join("\n")}\n`
      : `\n  every quote came from a specific picker\n`) +
    `\n  next: fill in the expected values, then\n` +
    `    npm run eval -- --labels ${outPath} --verify-labels\n`,
);
