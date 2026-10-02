/**
 * The synthetic sample corpus: fixtures/sample-cvs, the 40 generated CVs.
 *
 * The eval harness could already grade two kinds of source: a PDF by absolute path, and
 * inline text in fixtures/cvs.json. Neither can point at a document that ships with the
 * repository, which is what the sample corpus is, so this resolves a bare filename inside
 * fixtures/sample-cvs with the same containment rule the app uses for SCAN_ROOT: the
 * resolved real path must stay inside the corpus, so ".." or a symlink out of the tree is
 * refused rather than read.
 *
 * Lives in src/ rather than inside scripts/eval.ts so the offline tests can exercise it
 * with no API key and no network.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** One entry from fixtures/sample-cvs/manifest.json. */
export interface SampleEntry {
  file: string;
  pages?: number;
  language?: string;
  /** What the generator wrote this CV to be, in its own words. Intent, not ground truth. */
  profile?: string;
}

export interface SampleManifest {
  generator?: string;
  generator_version?: number;
  seed?: number;
  count?: number;
  reference_date?: string;
  files: SampleEntry[];
}

/** Absolute real path of a filename inside the corpus, or a clear error. */
export function resolveSamplePath(samplesDir: string, name: string): string {
  if (!name || name.includes("\0")) throw new Error("sample file name is empty");
  if (!existsSync(samplesDir)) throw new Error(`no sample corpus at ${samplesDir}`);
  const root = realpathSync(samplesDir);
  const full = resolve(root, name);
  if (!existsSync(full)) throw new Error(`no sample CV "${name}" in ${root}`);
  const real = realpathSync(full);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`sample CV "${name}" resolves outside the corpus (${real})`);
  }
  return real;
}

/**
 * The generator manifest. It records what each CV was written to be, which is what makes
 * the corpus reproducible, and it is deliberately not an answer key: a profile phrase is
 * the generator's intent, and agreeing with it is not the same as being right.
 */
export function loadSampleManifest(samplesDir: string): SampleManifest {
  const path = resolve(samplesDir, "manifest.json");
  if (!existsSync(path)) throw new Error(`no manifest at ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SampleManifest>;
  if (!Array.isArray(raw.files) || raw.files.length === 0) {
    throw new Error(`${path} has no files array`);
  }
  return raw as SampleManifest;
}
