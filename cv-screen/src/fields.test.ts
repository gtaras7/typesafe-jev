/**
 * Tests for switching a library field on.
 *
 * The Settings tab saves the policy it was sent, so a field it only knows by the card
 * summary (id, label, kind, weight) has to come back complete or the save is rejected as
 * "extraFields.<id>: Write the instruction the model should follow." Library entries ship
 * switched off, so that used to be the very first thing a user met.
 *
 * Run with:  npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FIELD_LIBRARY, libraryMeta, libraryField, hydrateLibraryField } from "./fields.js";
import { validatePolicy, type ExtraField, type Policy } from "./policy.js";
import { FOOD_INDUSTRY_POLICY, defaultPolicy } from "./presets.js";

/** What `/api/policy` used to send for a field: everything the card needs, nothing more. */
function asCardSummary(id: string): ExtraField {
  const meta = libraryMeta().find((m) => m.id === id);
  assert.ok(meta, `${id} appears in the field library`);
  return JSON.parse(JSON.stringify(meta)) as unknown as ExtraField;
}

/** The verified baseline carries no extra fields, so a test owns every one it adds. */
function policyWith(...fields: ExtraField[]): Policy {
  const policy = structuredClone(FOOD_INDUSTRY_POLICY);
  policy.extraFields.push(...fields);
  return policy;
}

const problemsWith = (policy: Policy, id: string) =>
  validatePolicy(policy).filter((i) => i.path === `extraFields.${id}`);

test("the card summary on its own cannot be saved as a field", () => {
  // The bug this suite exists for: the summary carries no instruction and no levels.
  const summary = asCardSummary("technical_depth");
  assert.equal(summary.instructions, undefined);
  assert.equal(summary.criteria, undefined);

  const messages = problemsWith(policyWith(summary), "technical_depth").map((i) => i.message);
  assert.deepEqual(messages, [
    "Write the instruction the model should follow.",
    "A rating scale needs at least two levels.",
  ]);
});

test("every library field survives being switched on from the card summary", () => {
  assert.ok(FIELD_LIBRARY.length >= 2, "the library has fields to check");
  for (const entry of FIELD_LIBRARY) {
    const hydrated = hydrateLibraryField({ ...asCardSummary(entry.id), enabled: true });
    assert.deepEqual(problemsWith(policyWith(hydrated), entry.id), [], `${entry.id} saves clean`);
    // The judgment has to be there for inference too, not just for the validator.
    assert.ok(hydrated.instructions?.trim(), `${entry.id} carries an instruction`);
    assert.ok(
      hydrated.kind === "noul"
        ? hydrated.noulCriteria?.true && hydrated.noulCriteria?.false
        : Object.keys(hydrated.criteria ?? {}).length >= 2,
      `${entry.id} carries its own levels or options`,
    );
  }
});

test("hydration keeps the choices the caller already made", () => {
  const hydrated = hydrateLibraryField({
    ...asCardSummary("technical_depth"),
    enabled: true,
    weight: 0.42,
  });
  assert.equal(hydrated.enabled, true);
  assert.equal(hydrated.weight, 0.42);
  assert.equal(hydrated.mode, "weight");
});

test("wording written by hand is never overwritten", () => {
  const mine = { ...libraryField("english_level")!, instructions: "My own instruction." };
  const hydrated = hydrateLibraryField(mine);
  assert.equal(hydrated.instructions, "My own instruction.");
});

test("a custom field is left exactly as it came", () => {
  const custom: ExtraField = {
    id: "custom_1700000000000",
    label: "Driving licence",
    kind: "noul",
    mode: "flag",
    weight: 0,
    instructions: "Does the CV mention a driving licence?",
    noulCriteria: { true: "Stated.", false: "Not stated." },
    enabled: true,
  };
  assert.deepEqual(hydrateLibraryField(custom), custom);
});

test("a kind spelled for display comes back in the policy's own spelling", () => {
  // public/index.html shows `noul` as "yesno" and normalises what it sends.
  const messy = { ...libraryField("employment_gaps")!, kind: "yesno" as unknown as ExtraField["kind"] };
  assert.equal(hydrateLibraryField(messy).kind, "noul");
});

test("switching on the two fields that failed now saves cleanly", () => {
  // The report this file came from: "extraFields.technical_depth: Write the instruction
  // the model should follow. ... extraFields.english_level: An options question needs at
  // least two options." on the real preset, with both new fields switched on.
  const policy = defaultPolicy();
  for (const id of ["technical_depth", "english_level"]) {
    policy.extraFields.push(hydrateLibraryField({ ...asCardSummary(id), enabled: true }));
  }
  assert.deepEqual(validatePolicy(policy), []);
  assert.deepEqual(
    policy.extraFields.map((f) => f.id),
    ["career_progression", "technical_depth", "english_level"],
  );
});