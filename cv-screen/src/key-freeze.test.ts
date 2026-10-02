/**
 * Offline tests for the sample corpus resolver and the key fingerprint. No API key, no network.
 *
 * These lock the two things that make a reproducible run possible: a sample CV can only be
 * read from inside the corpus, and the fingerprint of a key depends on the labels and not on
 * where the machine happens to keep them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSampleManifest, resolveSamplePath } from "./sample-corpus.js";
import { canonicalKey, findTodos, fingerprintKey, parseKeyFile, renderKeyFile } from "./key-freeze.js";
import type { CvLabels, Expected, LabelsFile } from "./eval-compare.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SAMPLES = join(ROOT, "fixtures", "sample-cvs");

// ---------------------------------------------------------------------------
// fixtures/sample-cvs
// ---------------------------------------------------------------------------
test("the sample corpus ships with the repository and holds the generated CVs", () => {
  const manifest = loadSampleManifest(SAMPLES);
  assert.equal(manifest.files.length, 40, "expected the 40 generated CVs");
  assert.equal(manifest.count, 40);
  assert.equal(manifest.seed, 7, "the seed is what makes the corpus reproducible");
  for (const entry of manifest.files) {
    assert.ok(entry.file.endsWith(".pdf"), `${entry.file} is not a PDF`);
    assert.ok(existsSync(join(SAMPLES, entry.file)), `${entry.file} is missing`);
  }
});

test("resolveSamplePath accepts a real CV and refuses everything outside the corpus", () => {
  const manifest = loadSampleManifest(SAMPLES);
  const first = manifest.files[0]!;
  assert.equal(resolveSamplePath(SAMPLES, first.file), join(SAMPLES, first.file));

  // An absolute path wins over the corpus root, and this one really exists, so the
  // containment check is what refuses it rather than the existence check.
  assert.throws(() => resolveSamplePath(SAMPLES, "/etc/passwd"), /resolves outside/);
  // A traversal that lands on nothing is refused earlier, as a missing file.
  assert.throws(() => resolveSamplePath(SAMPLES, "../../../etc/passwd"), /no sample CV/);
  assert.throws(() => resolveSamplePath(SAMPLES, "nope.pdf"), /no sample CV/);
  assert.throws(() => resolveSamplePath(SAMPLES, ""), /empty/);
  // A ".." that resolves back inside the corpus is fine: containment is checked on the
  // resolved real path, not on the string, so this normalises rather than throwing.
  assert.equal(resolveSamplePath(SAMPLES, "subdir/../manifest.json"), join(SAMPLES, "manifest.json"));
});

// ---------------------------------------------------------------------------
// The key fingerprint
// ---------------------------------------------------------------------------
function labelsWith(path: string, expected: Expected): LabelsFile {
  const cv: CvLabels = {
    kind: "pdf",
    source: "cv.pdf",
    path,
    labels: {
      education: { expected, quote: "Πτυχίο Τεχνολογίας Τροφίμων" },
      military: { expected: "undetermined", quote: "not stated" },
    },
  };
  return { meta: {}, cvs: { "cv.pdf": cv } };
}

test("the fingerprint does not change when the same CV moves to another folder", () => {
  const a = fingerprintKey(labelsWith("/home/one/Downloads/cv.pdf", "food_technology"));
  const b = fingerprintKey(labelsWith("/Users/two/Documents/files/cv.pdf", "food_technology"));
  assert.equal(a.hash, b.hash, "an absolute path prefix must not be part of the key");
});

test("the fingerprint changes when a label changes, which is the whole point", () => {
  const before = fingerprintKey(labelsWith("/x/cv.pdf", "food_technology"));
  const after = fingerprintKey(labelsWith("/x/cv.pdf", "chemistry"));
  assert.notEqual(before.hash, after.hash);
  assert.equal(before.cvs, 1);
  assert.equal(before.labels, 2);
  assert.equal(before.determinate, 1, "an undetermined label is not graded");
  assert.equal(before.undetermined, 1);
});

test("canonicalKey is stable across key and label order", () => {
  const one: LabelsFile = { meta: {}, cvs: { b: { kind: "sample", source: "b.pdf", file: "b.pdf", labels: { z: { expected: true, quote: "q" }, a: { expected: false, quote: "r" } } }, a: { kind: "sample", source: "a.pdf", file: "a.pdf", labels: { m: { expected: 1, quote: "s" } } } } };
  const two: LabelsFile = { meta: {}, cvs: { a: one.cvs.a!, b: { ...one.cvs.b!, labels: { a: { expected: false, quote: "r" }, z: { expected: true, quote: "q" } } } } };
  assert.equal(canonicalKey(one), canonicalKey(two));
});

test("a key file round-trips: rendered, then parsed back", () => {
  const fp = fingerprintKey(labelsWith("/x/cv.pdf", "food_technology"));
  const text = renderKeyFile(fp, "2026-10-01");
  const parsed = parseKeyFile(text);
  assert.equal(parsed.hash, fp.hash);
  assert.equal(parsed.frozen, "2026-10-01");
  assert.equal(parseKeyFile("no key here").hash, null);
});

test("the committed key, if present, matches the current labels file", () => {
  const keyPath = join(ROOT, "evals", "KEY.sha256");
  const labelsPath = join(ROOT, "evals", "labels.json");
  if (!existsSync(keyPath) || !existsSync(labelsPath)) return;
  const committed = parseKeyFile(readFileSync(keyPath, "utf8"));
  const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as LabelsFile;
  assert.equal(
    committed.hash,
    fingerprintKey(labels).hash,
    "evals/labels.json no longer matches the frozen evals/KEY.sha256",
  );
});

// ---------------------------------------------------------------------------
// A scaffold is not a key
// ---------------------------------------------------------------------------
test("findTodos flags only unfilled judgments, and only at the start of a note", () => {
  const labels: LabelsFile = {
    meta: {},
    cvs: {
      a: {
        kind: "sample",
        source: "a.pdf",
        file: "a.pdf",
        labels: {
          one: { expected: "undetermined", quote: "q", note: "TODO: set expected (true | false)." },
          two: { expected: true, quote: "q" },
          three: { expected: true, quote: "q", note: "a settled note that mentions TODO later" },
        },
      },
    },
  };
  assert.deepEqual(findTodos(labels), ["a/one"]);
});

test("the scaffolded key refuses to be a key: nothing filled in, everything TODO", () => {
  const scaffoldPath = join(ROOT, "evals", "labels.sample-cvs.json");
  if (!existsSync(scaffoldPath)) return;
  const scaffold = JSON.parse(readFileSync(scaffoldPath, "utf8")) as LabelsFile;
  const manifest = loadSampleManifest(SAMPLES);

  let total = 0;
  let filled = 0;
  for (const cv of Object.values(scaffold.cvs)) {
    for (const lab of Object.values(cv.labels)) {
      total++;
      if (lab.expected !== "undetermined") filled++;
    }
  }

  assert.equal(Object.keys(scaffold.cvs).length, manifest.files.length);
  assert.equal(total, manifest.files.length * 10, "every CV gets all ten questions");
  assert.equal(filled, 0, "the scaffold must not guess a single expected value");
  assert.equal(findTodos(scaffold).length, total, "every scaffolded label must stay TODO");
  assert.match(String(scaffold.meta.note ?? ""), /NOT a key/i);

  // and every entry points at the corpus rather than at a path on this machine
  for (const [key, cv] of Object.entries(scaffold.cvs)) {
    assert.equal(cv.kind, "sample", `${key} should use the sample source kind`);
    assert.ok(cv.file?.endsWith(".pdf"), `${key} needs a file inside the corpus`);
    assert.equal(cv.path, undefined, `${key} must not carry an absolute path`);
  }
});
