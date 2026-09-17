# Evaluation harness

Measuring whether Jev's judgments are actually correct, before trusting any score.

```bash
npm run eval -- --verify-labels   # offline: check ids and quotes, no API calls, free
npm run eval                      # live: screen every CV and grade the answers
npm run eval -- --json            # machine-readable
npm run eval -- Nikolaos_Papadopoulos_CV.pdf   # one CV
```

## ⚠️ Read this before trusting any number

**The labels in `labels.json` are PROPOSED, not verified ground truth.** They were
derived by an agent reading the extracted CV text. That is a reading, not a fact.

Before tuning any threshold on these results, the project author must open `labels.json`, go CV by
CV, and either confirm or correct each expected value. Until that happens, an
"agreement" figure measures how closely Jev matches one agent's reading, which is
useful for finding disagreements but is not accuracy.

Every label carries a `quote` copied verbatim from the CV it is about, and
`--verify-labels` fails if any quote cannot be found in its source text. That makes a
fabricated justification impossible to leave lying around. It does not make the
inference correct: a real quote can still support a wrong conclusion.

## What it measures, and what it deliberately does not

It grades **raw per-question answers** against labels: the boolean for a Noul, the
chosen option key for a Choice, the most probable level index for a Score.

It does **not** grade the composite score, the gates, or the recommendation. Those are
policy layered on top of the judgments and they change independently, so grading them
here would conflate "the model was wrong" with "we changed a weight".

## The test set

| CV | Why it is here |
|---|---|
| `Nikolaos_Papadopoulos_CV.pdf` | The clear positive: food technologist, 8+ years food R&D |
| `cv_b_other` | **Byte-identical** to the file above. Scoring it twice measures run-to-run variance, not accuracy |
| `Eirini_Stamatou_CV.pdf` | The middle case: accepted degree, food-adjacent roles, four employers in four years, under 28 |
| `Dimitrios_Konstantinou_CV.pdf` | The clear negative: mechanical engineer, no food sector at all |
| `cv_a_foodchem` | Negative in English: Business Computing, IT experience only. The key name is misleading, there is no food chemistry in it |

Five entries, **four distinct CVs**. The duplication is intentional.

## Expectations

- Noul: `true` or `false`
- Choice: the option key, or an array of equally acceptable keys
- Score: the level index, or an array of acceptable indices
- `"undetermined"`: the CV does not determine the answer. Never graded, and excluded
  from the denominator so an unknowable question cannot deflate the score

Prefer `"undetermined"` over a guess. A label that guesses is worse than no label,
because it manufactures false mismatches.

## Correcting a label

Edit `evals/labels.json`, keep the quote verbatim from the CV, then:

```bash
npm run eval -- --verify-labels   # confirms the quote still exists and ids are complete
npm run eval                      # re-grade
```

Set `expected` to an array when the CV genuinely supports more than one reading, and say
so in the `note`. Hiding a real disagreement behind a permissive array is its own kind of
error, so treat an array as a last resort and explain it.

## Adding a CV

Add an entry under `cvs` with `kind` of `"pdf"` (plus an absolute `path`) or
`"fixture"` (plus a `fixtureKey` into `fixtures/cvs.json`), and all ten question labels.
`--verify-labels` will tell you if you missed any.

## Current standing, and what it does NOT mean

Last live run: **50/50 = 100%** agreement across 5 entries (4 distinct CVs), 17.1k tokens.

Do not read that as "Jev is 100% accurate". Read it as "no disagreements remain on these
four hand-picked CVs", which is a much weaker claim:

- **Four CVs is not a sample.** It cannot support an accuracy estimate. It found a bug,
  which is what a small targeted set is good for, and it cannot tell you a rate.
- **The labels are one agent's reading, and one was already corrected after the fact.**
  The `stability_red_flag` label for Eirini was wrong (it counted an employer whose role
  ended three weeks before the four-year window opened) and was fixed. That correction
  was justified by the date arithmetic, but a labels file that has ever been aligned to
  model output is no longer fully independent.
- **The set is built from clear cases.** Every CV here is legible and internally
  consistent. Real applicant CVs are messier, and that is where a decision model is most
  likely to fail.
- **A corrected question was graded with labels written while knowing Jev's answers.**
  The `evidence_quality_flag` labels predate the fix, but the decision to narrow the
  question came from seeing how Jev answered.

The honest summary of round one: eight of ten questions agreed on every CV from the
start, one question had a specification bug worth 3 of 5 CVs, and the single apparent
model error turned out to be a labeling error. To turn any of that into an accuracy
figure you need, roughly, twenty or more CVs with labels written by the project author without
looking at Jev's answers.

## Question reliability from round one

| question | agreement | verdict |
|---|---|---|
| experience_determinable, experience_level, education, food_sector_present, food_sector_depth, age_evidence, military_status, rnd_priority | 5/5 each | reliable on clear CVs |
| stability_red_flag | 5/5 after correction | reliable boolean, but poorly calibrated: it returned p=0.42 on a case that is unambiguous once you do the date arithmetic |
| evidence_quality_flag | 2/5, then 5/5 after the fix | was mis-specified, see below |

## The issue round one found: evidence_quality_flag

The original question asked whether a CV "contains contradictions, or is missing core
information that would plausibly change the qualification decision", and its `true`
criterion included "a core criterion with no evidence at all".

That last clause did unintended work. A candidate with no food-sector background has a
core criterion with no evidence, so Jev answered yes, even though the CV was internally
consistent and complete. Three of five CVs came back `true` at probabilities of 0.66,
0.84 and 0.93.

Jev was following the criteria as written. The wording conflated two different questions:

1. **Is this CV internally weak?** Contradictory dates, unusable dates throughout. Rare,
   and a genuine data-quality signal.
2. **Does this candidate fail to match the role?** Common, and already fully captured by
   the gates and the composite.

Folded together, the flag stopped meaning "read this CV, it is hard to parse" and started
meaning "this candidate is a bad fit", duplicating the score. It is now scoped explicitly
to internal quality and told to ignore role fit, and agreement went to 5/5.

## The recurring lesson: do not make Jev do arithmetic

Two of the three issues found so far were arithmetic, not judgment:

- `experience_level` was the only dimension showing run-to-run variance, because the
  question asks Jev to total up years across roles.
- `stability_red_flag` was poorly calibrated because the question asks Jev to count
  distinct employers inside a rolling four-year window.

Both are computable in code from extracted dates, and code does them exactly and for
free. The durable fix is to have Jev report the employer list or the date ranges and let
code do the counting, rather than asking a language model to be a calculator.

