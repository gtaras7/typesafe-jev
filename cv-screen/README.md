# Jev CV screening

A local screening workbench for a folder of CVs. Point it at one CV or a folder of hundreds, it
asks TypeSafe's Jev a small fixed set of typed questions about each one, scores the answers with
plain arithmetic you can read, and shows a sortable table with one verdict per candidate:
**ready for interview**, **maybe**, **pass**, plus a separate **needs review** marker that never
overrides the verdict.

> A folder of CVs is judged once. After that, changing a weight, a cap or a threshold re-scores
> every stored candidate in about 20 ms and costs exactly nothing, because every number is
> recomputed from the judgments already on disk. Only adding a brand new question costs tokens,
> and only for the CVs that have not answered it yet.

It is deliberately not a chat app and not a prompt. Every question is one narrow judgment, every
weight, cap and threshold lives in a policy you edit in the app, and the arithmetic is done by
code rather than by a model.

## What it is, concretely

A local web app with no runtime dependencies and no build step: the server is `node:http`, the
store is SQLite through `node:sqlite` (both built into Node 22), and the interface is a single
static HTML file with vanilla JS.

The model is Jev, reached at `POST https://api.typesafe.ai/v1/systemone` with the model id
`jev-latest` (currently reporting `jev-1.13.0`). The API key is read on the server only. The
browser sends CV text and receives scores, so the key never appears in page source or in a
network request. The server listens on `127.0.0.1` only.

How one CV is judged:

1. **One request per CV.** All of that CV's questions are batched into a single call, typed:
   yes/no, a closed option set, or an ordered rating scale. Jev answers with a probability
   distribution and a confidence rather than prose.
2. **Code does everything after the answer.** The weighted match score, the gates and their hard
   caps, the decision lines, the strengths and gaps, and the sentence explaining the score are all
   computed in `src/compose.ts` from the raw answers.

The role is a policy you edit in the app: accepted degrees, minimum years, the age rule, the
military rule, job stability limits, hard caps, sector question, extra questions. Saving it
re-scores every stored candidate for 0 tokens, because the judgments are still valid. The footer
says so in plain words, and if the change asks a question some CVs have never been asked, it
offers a button to re-scan only those.

## Run it

Node 22 and `npm install` (dev dependencies only: `tsx`, `typescript`, `@types/node`).

```bash
npm install
cp .env.example .env            # then put your key in TYPESAFE_API_KEY
npm run ui                      # -> http://localhost:8799
```

Get a key from https://console.typesafe.ai/settings/keys. `.env` is gitignored, and a real
environment variable wins over the file. If the key is missing, the app still boots and screening
returns a clear error instead of a silent failure.

PDF text comes from pymupdf through a small python script (`scripts/pdf_to_text.py`). The
interpreter is probed at boot and printed:

```
  pdf:    /usr/local/bin/python3
```

If that says `UNAVAILABLE`, install pymupdf (`python3 -m pip install pymupdf`) or point
`JEV_PYTHON` at an interpreter that has it. `python3` on PATH is often a tool python without it,
which only fails once a real folder is being read. Plain text and markdown files skip python
entirely.

`data/` is created on first run and is gitignored on purpose: it holds the SQLite run log and a
copy of every CV that has been screened, which is real people's documents.

Then, three tabs:

**Screen.** Drop one PDF, many PDFs, or a whole folder, or paste a CV as text. Uploads go in
groups of 8, so the first verdicts appear while the rest are still arriving, and the header fills
in live: counters, CVs per minute, average time per CV, time left, tokens, cost. A folder already
on this machine can also be screened without uploading it, which is what the bench uses.

Starting a new run **replaces** the previous shortlist. Screening a different folder, or pasting a
different CV, clears what was there before it begins, because the app is built around the role
being hired for right now and rows judged under an older policy would sit in the same table
looking comparable when they are not. The clearing happens in the same request that starts the
run, so the table is never briefly wrong. The API itself stays additive unless the caller asks
for a reset, which is why scripts and the CLI behave the way they did.

**Candidates.** An Excel shaped table: name, file, match score, verdict, a needs a look marker,
then one narrow bar per dimension and per extra field. Sort by clicking a header, filter with the
chips, search by name or file, and **Export to Excel (CSV)**. Clicking a row opens everything
behind its score: the model's own words for each judgment, the gates, the review reasons and the
softer notes it logged, the raw typed answers, and the exact questions that were sent. **Clear**
empties the shortlist without starting a new run. It asks with a second click rather than a dialog
box, so the first click arms it and says how many candidates are about to go.

**Settings.** The role as a form, in plain language: role name, minimum years, accepted degrees as
removable chips, the age, military and sector rules, how much each thing matters, where the
interview and maybe lines sit, and the extra fields, with a library of ready made questions to
switch on plus a builder for your own.

## What it tests about the model

This project is also an argument about how to use a decision model. Each point below is something
the code relies on, and the run in the next section exercises it.

- **Jev returns structured answers with calibrated confidence and probabilities, not prose.**
  A yes/no comes back as one number (the chance the answer is yes), an options question as the
  chosen option plus a distribution over all options, a rating as a position along the ordered
  levels plus the mass on each level. Nothing in the app parses a sentence.
- **A closed set choice can be a disqualifying gate.** The education question is an options
  question with a no match option, and the same answer carries both the gate and the graded
  signal: the probability mass on the no match option is what rejects, so a candidate who is
  merely adjacent does not have to be counted as a hard no by hand.
- **A yes/no is a near 0.5 coin flip, not a middle intensity.** The TypeSafe docs are explicit
  that a noul value of 0.5 means yes and no are equally likely, not that the candidate has a medium
  level. So every yes/no here is thresholded in code, and for a gate, a probability inside the
  0.35 to 0.65 band is treated as too close to call and routed to a person instead of being read
  as a decision.
- **A rating with explicit level descriptions handles the between level cases.** A score answer
  can land between two levels (1.6 on a 0 to 2 scale is normal). The hands-on depth field gives
  every level a description plus a couple of example situations, which the docs report as the
  remedy when the model keeps landing between two neighbouring levels.
- **The same policy builds the same questions.** The question map is a pure function of the policy
  and the date (`buildQuestions`), and the list of question ids a policy asks is generated from
  that same function, so the two can never drift and nothing about the request is improvised per
  CV. The only input that moves day to day is the date inside the age question.
- **The answers are stable enough to grade a whole folder, and a folder is cheap.** One policy, one
  question set, run over 40 and then 15 CVs, with per CV costs measured in the next section.

### The hands-on engineering depth scale

One extra field is a rating from 0 to 5, quoted from `src/fields.ts`. Each level also carries
example situations, which are omitted here for length.

| Level | What the level covers |
|---|---|
| 0 | No role or project where the candidate wrote code. |
| 1 | Code appears only as coursework, a bootcamp or a tutorial exercise. |
| 2 | Small scoped work inside someone else's design, such as bug fixes, small features, tests or scripts. |
| 3 | Owns features end to end, from design through shipping and keeping them running. |
| 4 | Owns a whole system or service and makes its architectural decisions. |
| 5 | Deep specialist with real breadth, such as hard production problems solved across more than one area. |

### The career progression question

One options question whose four options land on four different credits, the pattern from the
TypeSafe demo: `steady_growth` 1.00, `lateral_moves` 0.65, `job_hopping` 0.25, and `unclear`, which
takes the policy's partial credit of 0.47 and routes the candidate to a person. The TypeSafe docs
do not publish that question, so this is this project's implementation of it, built on the
documented pattern of scoring dimensions separately and combining them in code. `docs/typesafe-notes.md`
records what the docs do and do not contain, with sources for every claim.

## Results

### Example 1: food industry, 40 synthetic CVs

The role is the QA / R&D / production preset (a chemistry, agronomy or food technology degree, 3+
years, food-sector background, over 28, military service, stable employers, career progression
switched on). The corpus is `fixtures/sample-cvs`, 40 generated CVs, concurrency 8.

| | |
|---|---|
| Wall time | **3.1 s** for 40 CVs, 0 failures |
| Throughput | **783 CVs per minute** |
| Latency | 301 ms fastest, **338 ms median**, 930 ms p95 |
| Tokens | 3,656 per CV, **146,252** for the folder |
| Cost | **$0.0061** for the folder, **$0.00015 per CV** |
| Extrapolated | 300 CVs would take about **23 s** and about **$0.046** (an extrapolation from the measured rate and per CV cost, not a measurement) |
| Re-scoring after a policy change | every stored candidate, **0 tokens**, no API call |
| Model | `jev-1.13.0` (`jev-latest`) |

Cost is charged on input tokens only, output is free, at the published price of $42 per billion
input tokens (https://docs.typesafe.ai/models.md). One accounting note the two examples differ on:
`scripts/bench.ts` prices every token it counts at that input rate, so example 1 is a mild
overestimate, while the app prices input only, which is the figure example 2 quotes from. Same
price, slightly different denominators.

### Example 2: frontend, 15 demo CVs, before and after one setting

The role is the Software engineer preset. The folder is 15 demo CVs whose file names encode the
intended bucket, STRONG, MID or NOFIT. **Those names are the demo author's intent and not verified
ground truth**: the demo was written to make the model's misses visible, and the intended bucket
was never confirmed by a careful reading. Concurrency 8.

Run A, the preset exactly as it ships (8 questions per CV: the core dimensions plus the 4 extra
fields the preset switches on):

| | |
|---|---|
| Wall time | 1.8 s for 15 CVs, 0 failures |
| Throughput | 490 CVs per minute |
| Latency | 286 ms fastest, 746 ms median, 863 ms p95 |
| Tokens | 35,520 |
| Cost | $0.00136 for the folder |
| Verdicts | 9 ready for interview, 5 maybe, 1 pass |
| Matching the intended bucket | 6 of 15 |

The miss that matters: three NOFIT candidates who are backend developers with no frontend work
scored 0.80 to 0.90. The role as it shipped never asks whether the CV shows the stack, so those
candidates were right about everything the questions covered and wrong about the job.

Run B, after changing one setting: the sector question switched on and labelled `frontend
development with React or React Native` (weight 0.3), experience raised to 0.3, stability dropped
to 0. Nothing else moved.

| | |
|---|---|
| Saving the policy | re-scored all 15 in **18 ms using 0 tokens** |
| Then | 15 of 15 needed the new question asked, 15 of 15 answered in **1.4 s**, 0 failures |
| Tokens | 36,780 |
| Cost | about $0.0015 |
| Shortlist | still **15 rows**: a re-ask replaces a candidate, it does not duplicate them |
| Verdicts | 5 ready, 7 maybe, 3 pass |
| Matching the intended bucket | **9 of 15** |
| The three backend candidates | capped at **0.55**, with the reason `capped at 0.55 because there is no experience in frontend development with React or React Native` |
| Both runs together | about **$0.0029** for that folder |

Two things worth reading off that table. First, the change that mattered was not a weight, it was
the question: no slider could have separated those three candidates, because nothing in the
question set looked at the stack. Second, the cap sits exactly on the maybe line, and this role
lists no rejecting gates, so a capped candidate reads as maybe rather than pass, which is the
intended shape: a person should look, the score should not pretend to have decided.

## Two bugs the demo data caught

Both were found by running the frontend folder rather than by reasoning about the code, and both
are fixed and covered by tests.

**The education weight with no accepted degrees.** The Software engineer preset kept a weight on
the education dimension while listing no accepted degrees. With an empty list, every CV lands on
the no match option by definition, so the education gate failed for everybody and its 0.5 cap
flattened 11 of the 15 candidates onto exactly 0.500. That is a silent and total loss of signal:
the ranking still looks like a ranking, but it is an artifact of one gate. Two fixes. The education
question is now only built when the policy actually lists accepted degrees, and `compose.ts` only
scores it when it was asked. And `validatePolicy` refuses the incoherent policy up front: "The
education weight needs accepted degrees to judge against, or every candidate fails it. Add a
degree, or set the weight to 0."

**The re-ask that duplicated everyone.** Re-asking a candidate, which is what the rescan job does
after a new question is added, built its task from the CV text that came back out of the store and
hashed that text for row identity. The hash matched no stored row, so every re-asked candidate was
inserted as a second copy: 30 rows for 15 CVs. A candidate would appear twice on the shortlist
with two different scores. Fixed by carrying the row's identity into the re-ask task, so an answer
replaces the candidate it belongs to. Verified in the run above: after re-asking all 15, the
shortlist still holds 15 rows.

## Extra fields

The field library, each entry one narrow judgment:

| Field | Type | What it reads |
|---|---|---|
| **Career progression** | options | steady growth, lateral moves, job hopping, unclear |
| **Hands-on depth** | rating 0 to 5 | what the candidate personally built, how hard it was, how much they owned |
| Ownership and leadership | rating 0 to 4 | whose work depended on them, and how much |
| Communication | rating 0 to 3 | written and spoken work aimed outside their own team |
| Direction of the CV | options | whether the CV points at this kind of work |
| English level | options | judged from the CV's own writing and where they have worked |
| Relevant certification | yes/no | a completed licence or qualification, not a course attended |
| Unexplained gaps | yes/no, flag only | a long unexplained stretch, for a person to read. Never scored |

Library entries ship switched off. Fields you add yourself are the same machinery: a rating scale
with ordered levels, an options question with a credit per option, or a yes/no, either with a
weight or as a flag that never touches the score. A field with no levels or fewer than two options
is never asked at all, because an empty scale would make the model invent levels.

## What it deliberately does not do

- **No arithmetic by the model.** An age is never asked for: the model reports which kind of age
  evidence the CV contains, and the policy value is applied in code. The eval harness found the two
  worst calibrated questions were exactly the two that asked Jev to count something (years of
  experience, distinct employers in a window), which is why an uncertain yes/no is scored as its
  expectation rather than a hard 0 or 1.
- **No invented scores.** A question a CV was never asked is left out of the score, its weight
  leaves the normaliser with it, and the row is marked as needing one more pass.
- **No silent prose.** Strengths, gaps and the explanation are assembled in code from the per
  dimension answers, so the score and the words cannot contradict each other.
- **No mixing of roles in one shortlist.** The app is built around the role being hired for right
  now, so re-screening the same CV updates its row rather than adding a second copy, and the row is
  matched on the document's content hash rather than its file name.

## Commands

```bash
npm run ui                                    # the app, http://localhost:8799
npm test                                      # 63 tests, no API key, no network
npm run typecheck
npm run ingest -- PATH                        # the same job headless, prints a table
npm run ingest -- PATH --rescore              # re-score with no API calls, 0 tokens
npm run ingest -- PATH --list                 # print what is already stored
npm run screen -- --fixture cv_b_other        # one CV through the CLI, food role
npm run screen -- --cv ./cv.txt --dry         # print the request, make no API call
npm run sample-cvs                            # 40 synthetic CVs into fixtures/sample-cvs
npm run bench -- --path fixtures/sample-cvs --concurrency 8 --extrapolate 300
npm run smoke                                 # live end-to-end check
npm run eval -- --verify-labels               # check the eval labels offline, free
npm run eval                                  # grade raw judgments against labelled CVs
npm run report -- out/run.json -o out/report.html
npm run probe                                 # dump the raw answers for the two fixtures

# switch role from a script: food-industry-qa, software-engineer, any-role
curl -s -X POST localhost:8799/api/policy/preset \
  -H 'content-type: application/json' -d '{"id":"software-engineer"}'
```

Scripts that call the model, and so need `TYPESAFE_API_KEY`: `ui`, `ingest` (without `--rescore`
or `--list`), `screen` (without `--dry`), `bench`, `smoke`, `eval` (without `--verify-labels`),
`probe`. `bench` and `smoke` also need the app already running, and `smoke` clears the shortlist
before it starts unless you pass `--keep`. `report` renders saved run JSON, or reads the store
directly with `--store data/jev.sqlite`, and writes a standalone HTML page. `sample-cvs` needs
`python3`, not a key.

`smoke` and `bench` are the two worth running after any change: they use the real API and assert
on real numbers, including that re-scoring costs zero tokens and that adding a field never invents
a score.

## Files

| Path | Role |
|---|---|
| `src/policy.ts` | **The policy as data.** Weights, caps, thresholds, extra fields, and the validator that refuses an incoherent one |
| `src/fields.ts` | The field library: the ready made questions and their rubrics |
| `src/presets.ts` | Starting points: food industry QA/R&D, software engineer, blank |
| `src/questions.ts` | Builds the question map from the policy. One request per CV |
| `src/compose.ts` | The match score, gates, caps, review routing, notes. Pure, no network |
| `src/recompose.ts` | Re-scores stored runs under a new policy. Zero tokens |
| `src/worker.ts` | The batch queue, progress events, PDF reading |
| `src/server.ts` | The app and its JSON API |
| `src/store.ts` | SQLite run log, one row per CV, deduped by content hash |
| `src/pdf.ts` | pymupdf extraction, batched, with interpreter detection |
| `src/pricing.ts` | What a run costs, at the published price |
| `src/cli.ts` | One CV from the command line, for a quick look |
| `src/ingest.ts` | A folder from the command line, into the same store the app uses |
| `public/index.html` | The whole interface: vanilla JS and CSS, no build step |
| `docs/ui-contract.md` | The frozen API contract the page is built against |
| `docs/typesafe-notes.md` | The TypeSafe docs, distilled, with sources |
| `scripts/make-sample-cvs.py` | The deterministic synthetic corpus |
| `scripts/smoke.ts`, `scripts/bench.ts` | Live end-to-end checks, and throughput and cost |
| `evals/` | The eval harness and its honest caveats |
| `data/` | The store, the saved policy and a copy of every screened CV. Gitignored |

## Tests

`npm test` runs 63 tests with no API key and no network. They lock down the arithmetic that used
to live inside a prompt: caps, gates, partial credit, the three zone treatment of a close call,
the normaliser, the CSV escaping, and that re-scoring never calls the model. The six core
dimensions are also checked to be bit identical to the original verified role, so the food
industry numbers did not drift when the app grew around them.

## Gate semantics

Two rules that are easy to get wrong, both still in force:

**A failed gate is not just a lower score.** `rejectingGates` in the policy lists the gates that
force `PASS` outright. The education gate is one, because its cap of 0.50 is exactly equal to
`thresholds.maybe`, so a capped disqualified candidate would otherwise land on MAYBE. The food
sector gate is deliberately **not** rejecting: its 0.55 cap sits above MAYBE on purpose, since a
wrong degree is more fatal than a missing sector background. That is also why the three capped
candidates in the frontend run read as maybe.

**A close call is not a decisive one.** Binary gates use a three zone rule against the review band
(`borderlineLow` 0.35, `borderlineHigh` 0.65): at or above 0.65 scores 0, at or below 0.35 scores
1, and in between scores the expectation and routes to a human. Before this, a 51/49 stability call
zeroed a dimension worth 0.15 of the total. Low confidence is a note, and it only becomes a reason
to look when the final score is also sitting within 0.05 of a decision line.

## Honest caveats

- **The 40 CV corpus is synthetic.** `fixtures/sample-cvs` is generated by
  `scripts/make-sample-cvs.py`, and every file is marked `SYNTHETIC SAMPLE CV` on its first line.
  The generator writes them to be deliberately messy: 4 to 6 employers in about 3 years for some,
  unclear or overlapping timelines, a few with no usable dates, and a share with degraded
  characters imitating a bad Greek text layer. A review flag and a low score on this corpus are a
  property of the corpus, not a statement about the model on real applicants.
- **The demo folder's bucket names are intent, not truth.** STRONG, MID and NOFIT in the frontend
  file names are what the demo author meant to write, so "9 of 15 matched" is a measure of
  agreement with that intent, not an accuracy figure.
- **The thresholds are still guesses.** 0.75 and 0.5 were never tuned on real hiring outcomes, and
  `evals/README.md` says the same about its labels.
- **The eval set is four distinct CVs.** It proves the pipeline agrees with a careful reading on
  clear cases. It cannot support an accuracy figure, and one of its labels had to be corrected
  after the fact.
- **The n8n integration is gone.** This project started life as an n8n workflow. The generated
  exports, the generator that produced them and the plain JS port of the old policy have all been
  removed, because the policy became editable at runtime and a frozen port cannot express that. What
  is in this repository is the whole project.
