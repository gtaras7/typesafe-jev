/**
 * Pre-registration for the expectation key.
 *
 * The rule is: the key is fixed BEFORE the model is called, and the proof is a hash
 * committed ahead of the run. Without it, a labels file that has ever been aligned to
 * model output stops being independent, and an agreement figure measures the alignment
 * rather than the model.
 *
 * evals/labels.json cannot be the record itself, because it is gitignored on purpose: it
 * quotes absolute paths and real people's documents. So the record is a fingerprint of
 * the labels, committed in evals/KEY.sha256, and this module produces and checks it.
 *
 * The fingerprint deliberately ignores the machine-specific parts of the file. An absolute
 * `path` is reduced to its basename, and `name` and `note` are dropped, because moving a
 * CV between two folders changes none of the labels. Everything that determines what was
 * asked and what the answer was meant to be is included, and the entries are sorted, so
 * the same key fingerprints the same on any machine and in any key order.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { CvLabels, LabelsFile } from "./eval-compare.js";

export interface KeyFingerprint {
  /** sha256 over the canonical form of the labels, hex. */
  hash: string;
  cvs: number;
  /** Every label, including the ones with no ground truth. */
  labels: number;
  /** Labels with a real expected value, i.e. the ones an agreement figure divides by. */
  determinate: number;
  /** Labels set to "undetermined". Not graded, and excluded from the denominator. */
  undetermined: number;
}

/** Which document a label set is about, without the machine-specific prefix. */
function sourceIdentity(cv: CvLabels): string {
  if (cv.kind === "pdf") return cv.path ? basename(cv.path) : cv.source;
  if (cv.kind === "fixture") return cv.fixtureKey ?? cv.source;
  return cv.file ?? cv.source;
}

/** The exact content the fingerprint covers, as a stable JSON string. */
export function canonicalKey(labels: LabelsFile): string {
  const cvs = Object.entries(labels.cvs)
    .map(([key, cv]) => {
      const entries = Object.entries(cv.labels)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, lab]) => {
          const expected = JSON.stringify(lab.expected);
          // Quotes are only locked for graded labels: an "undetermined" label makes no
          // claim, so its justification is free to change without changing the key.
          return [id, expected, lab.expected === "undetermined" ? null : lab.quote];
        });
      return [key, cv.kind, sourceIdentity(cv), entries];
    })
    .sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
  return JSON.stringify({ version: 1, cvs });
}

export function fingerprintKey(labels: LabelsFile): KeyFingerprint {
  const hash = createHash("sha256").update(canonicalKey(labels), "utf8").digest("hex");
  let count = 0;
  let undetermined = 0;
  for (const cv of Object.values(labels.cvs)) {
    for (const lab of Object.values(cv.labels)) {
      count++;
      if (lab.expected === "undetermined") undetermined++;
    }
  }
  return {
    hash,
    cvs: Object.keys(labels.cvs).length,
    labels: count,
    determinate: count - undetermined,
    undetermined,
  };
}

/**
 * Every label whose note still starts with TODO, i.e. an unfilled judgment.
 *
 * The scaffold generator leaves all 400 expected values blank on purpose, so this is what
 * stops an unfinished reading from being frozen as if it were a key. Lives here rather than
 * in the script so the offline tests can cover it.
 */
export function findTodos(labels: LabelsFile): string[] {
  const out: string[] = [];
  for (const [key, cv] of Object.entries(labels.cvs)) {
    for (const [id, lab] of Object.entries(cv.labels)) {
      if (typeof lab.note === "string" && lab.note.trimStart().startsWith("TODO")) {
        out.push(`${key}/${id}`);
      }
    }
  }
  return out;
}

/** The committed record: one fingerprint line plus the counts, readable by a human. */
export function renderKeyFile(fp: KeyFingerprint, frozenOn: string): string {
  return [
    "# Pre-registered expectation key for the CV screening eval harness.",
    "#",
    "# Commit this file BEFORE any live run. It is the proof that the labels were fixed",
    "# before the model was called, which is the only thing that makes an agreement",
    "# figure mean anything. See evals/README.md.",
    "#",
    "#   npm run freeze-key            write or refresh this file",
    "#   npm run freeze-key -- --check fail if evals/labels.json no longer matches",
    "",
    `key          ${fp.hash}`,
    `cvs          ${fp.cvs}`,
    `labels       ${fp.labels}`,
    `determinate  ${fp.determinate}`,
    `undetermined ${fp.undetermined}`,
    `frozen       ${frozenOn}`,
    "",
  ].join("\n");
}

/** Pull the hash back out of a committed key file, or null if it has no key line. */
export function parseKeyFile(text: string): { hash: string | null; frozen: string | null } {
  let hash: string | null = null;
  let frozen: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^key\s+([0-9a-f]{64})\s*$/.exec(line.trim());
    if (m) hash = m[1] ?? null;
    const f = /^frozen\s+(\S+)\s*$/.exec(line.trim());
    if (f) frozen = f[1] ?? null;
  }
  return { hash, frozen };
}
