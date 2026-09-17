/**
 * Dump the raw System One answers for both fixtures, so the probability
 * distributions and confidence values can be inspected before tuning thresholds.
 * Usage: npx tsx scripts/probe.ts
 */
import { readFileSync } from "node:fs";
import { screenCv } from "../src/screen.js";
import { FOOD_INDUSTRY_QA as role } from "../src/role-spec.js";

const cvs = JSON.parse(readFileSync(new URL("../fixtures/cvs.json", import.meta.url), "utf8")) as Record<string, string>;

const names: Record<string, string> = {
  cv_b_other: "Nikolaos Papadopoulos",
  cv_a_foodchem: "Alexandros Papadakis",
};

for (const [fx, cvText] of Object.entries(cvs)) {
  const o = await screenCv(role, { cvText, name: names[fx] ?? fx, email: "" });
  console.log("=".repeat(78));
  console.log(`${fx}  model=${o.model}  tokens in=${o.usage.input_tokens} out=${o.usage.output_tokens}`);
  console.log(`  composite=${o.result.composite}  ${o.result.recommendation}  review=${o.result.needsHumanReview}`);
  console.log("-".repeat(78));
  for (const [k, a] of Object.entries(o.answers)) {
    if (a.type === "noul") {
      console.log(`  ${k.padEnd(26)} noul=${a.noul}`);
    } else if (a.type === "choice") {
      const probs = Object.entries(a.probabilities)
        .sort((x, y) => y[1] - x[1])
        .map(([opt, v]) => `${opt}=${v}`)
        .join("  ");
      console.log(`  ${k.padEnd(26)} choice=${a.choice.padEnd(22)} conf=${a.confidence}  [${probs}]`);
    } else {
      const probs = Object.entries(a.probabilities)
        .sort((x, y) => Number(x[0]) - Number(y[0]))
        .map(([lvl, v]) => `${lvl}:${v}`)
        .join("  ");
      console.log(`  ${k.padEnd(26)} score=${a.score.toFixed(3).padEnd(6)} conf=${a.confidence}  [${probs}]`);
    }
  }
}
