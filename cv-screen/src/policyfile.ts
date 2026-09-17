/**
 * The saved policy on disk. One JSON file, so "what we are hiring for" is a thing the
 * user can look at, copy to a colleague, or keep next to the results it produced.
 *
 * The file is the only stateful part of the app besides the run database, and it is
 * deliberately plain: no code, no version control needed, no build step.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { normalisePolicy, validatePolicy, type Policy, type PolicyIssue } from "./policy.js";
import { defaultPolicy } from "./presets.js";

export const POLICY_PATH = resolve(process.cwd(), "data", "policy.json");

export function loadPolicy(path = POLICY_PATH): Policy {
  try {
    if (!existsSync(path)) return defaultPolicy();
    return normalisePolicy(JSON.parse(readFileSync(path, "utf8")) as Partial<Policy>);
  } catch {
    // A hand-edited file with a typo must not stop the app from starting: fall back to
    // the default policy and let the user see it in Settings.
    return defaultPolicy();
  }
}

export function savePolicy(policy: Policy, path = POLICY_PATH): Policy {
  const issues: PolicyIssue[] = validatePolicy(policy);
  if (issues.length) {
    throw new Error(issues.map((i) => `${i.path}: ${i.message}`).join("\n"));
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(policy, null, 2) + "\n");
  return policy;
}
