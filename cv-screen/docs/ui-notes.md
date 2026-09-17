# UI notes

`public/index.html` is the whole interface: vanilla JS and CSS in one file, no build step, no
dependencies. This note records the contract between the page and the server, and the three
places where behaviour is deliberately not what an earlier draft did.

## Where the data comes from

On boot, `loadData()` tries `GET /api/meta` and `GET /api/candidates`.

- **API answers** (`MODE = "api"`): everything comes from the server. This is the only mode the
  app is meant to run in.
- **API absent** (`MODE = "mock"`, for example opening the file directly with `file://`): the page
  falls back to `MOCK_META`, `MOCK_CANDIDATES`, `MOCK_QUESTIONS`, `MOCK_PRESETS`, `MOCK_STATS` and
  `MOCK_BATCH`, which are constants inside the HTML. The header then says "offline demo data".

Those constants are illustrative only. They are not a second copy of the policy, and were not
generated from the real one, so never treat them as the shipped rubric. The JSON files that used
to live in `public/mock/` were removed for that reason: the page never read them, and a stale
second copy of the contract is worse than none.

## Server contract the page relies on

| Call | Used for |
|---|---|
| `GET /api/meta` | policy, field library with `enabled`, presets, `limits.defaultConcurrency`, `model.id` |
| `GET /api/presets` | the role preset picker (`presets` may be an array or `{presets: []}`) |
| `GET /api/candidates` | table rows, `stats`, `columns` |
| `GET /api/candidates/:id` | the detail panel: `row`, `answers`, `questions` |
| `POST /api/screen` | one pasted CV |
| `POST /api/batch` | start a job, with `{concurrency, total}` |
| `POST /api/batch/chunk` | `{jobId, files}` per group of 8 |
| `POST /api/batch/finish` | `{jobId}`, the client says it is done sending |
| `GET /api/batch/stream?jobId=` | server sent events: `job`, `info`, `progress`, `done` |
| `POST /api/rescan` | re-ask the candidates missing a newly added question |
| `PUT /api/policy` | save and re-score; reads `rescored{n,ms,tokens}` and `requiresInference` |
| `GET /api/export.csv` | the Excel button |

Row fields the table reads: `id, name, sourceFile, composite, recommendation, needsReview, stale,
dimensions[], fields{}, elapsedMs, tokens, costUsd, notes[]`.

## DOM contract

Layout: `header` holds `.brand-row` and `#stats-bar`; `nav.tabs` holds three
`button.tab[data-tab=screen|candidates|settings]`; `main` holds `section.panel#panel-<tab>` and
`#detail-panel`.

Header counters, each `<span class="stat">` with one `<b id=...>`:
`stat-interview`, `stat-maybe`, `stat-pass`, `stat-review`, `stat-total`, `stat-avgms`,
`stat-cpm`, `stat-tokens`, `stat-cost`, `stat-model`. Plus `#role-line`, `#key-line`, `#mode-line`.

Screen tab: `#dropzone`, `#choose-files`, `#choose-folder`, `#file-input` (multiple),
`#folder-input` (`webkitdirectory`), `#file-summary`, `#paste-text`, `#preset-select`,
`#screen-btn`, `#screen-status`, and the live batch block: `#batch-progress`, `#batch-bar`,
`#batch-count`, `#batch-avgms`, `#batch-cpm`, `#batch-eta`, `#batch-tokens`, `#batch-results`
(rows created by `addBatchRow`, each `div.batch-row[data-id]`).

Candidates tab: `#cand-filters` (chips carry `data-filter`: `all`, `INTERVIEW`, `MAYBE`, `PASS`,
`review`), `#cand-search`, `#cand-export`, `#cand-tbody` (rows carry `tr[data-id]`), `#cand-head`.

Settings tab: `#set-role-title`, `#set-min-years`, `#set-degree-input`, `#set-degree-add`,
the weight ranges (`input[type=range][data-attr=weight]`), `#set-thr-interview`,
`#set-thr-maybe`, `#set-age`, `#set-military`, `#set-sector`, the extra field switches and the
add-your-own-field builder, and the footer `#save-btn`, `#rescan-btn`, `#save-result`.

## Three behaviours that are deliberate

**A verdict and a "needs a look" marker are separate.** `verdictOf(row)` returns
`row.recommendation` and nothing else. An earlier draft returned a fourth verdict, `REVIEW`, for
any row with `needsReview`, which hid the real verdict on every flagged row and made the three
counters read zero on a folder where most rows wanted a look. Review is rendered as its own
marker and its own counter, and the `review` filter chip filters on `needsReview`.

**Notes are not review reasons.** `row.reviewReasons` means a person should look before trusting
the row. `row.notes` means the model was unsure somewhere and the score is not on a line, so it is
information rather than a task. The detail panel shows review reasons in the amber `.note` and
notes in the blue `.note.soft`.

**Uploads are chunked and the job is sealed by count, not by a timer.** The Screen tab starts the
job with `{concurrency, total}`, streams progress immediately, then posts files in groups of 8,
then calls `/finish`. The server seals the job when the number of files it has received reaches
`total`, so the gap between chunks can be as long as reading and base64-encoding a folder needs.
A timer remains as a fallback for a client that declares no total. A chunk sent to a finished job
gets HTTP 409 rather than being silently dropped, which was a real bug: a slow uploader lost the
tail of the folder.

## The header stats bar

Two groups, separated by a hairline: the shortlist (ready to interview, maybe, pass, needs a look,
total), then the run (scope label, run time, average ms per CV, CVs per minute, tokens, cost), then
the model.

The second group reports **one run** when a run is happening or has just finished, and everything
in the store otherwise. `RUN` in the page state is the source of truth: it is created on the job
event, updated by each progress event, and closed by the done event. The scope label (`all runs` /
`this run` / `last run`) exists because a number that silently changes meaning is worse than no
number. `ms` on a progress event is wall time since the run started, so `ms / done` is the average
wall time per CV and `60000 / avg` is what the user actually experienced. Cost accumulates the
per-row `costUsd` from the server rather than re-deriving it, and `runSingle` (a pasted CV) sets
`RUN` too, so one pasted CV still reports its own speed.

Two things deliberately not in the header any more: the `key: loaded` pill and the `live` pill. The
`live` / `offline demo data` distinction now rides on the role line instead, so the offline
fallback stays visible without its own badge, and a missing API key surfaces as a clear error when
screening is attempted.

## The Settings tab

**Rules holds general rules only.** Age over N (with the number editable), military service, job
stability (with its employer count and window), and the two hard limits under a separate "Hard
limits" heading. The sector question is role specific, so it lives with the role, next to the
accepted degrees, and its label is read from the policy (`experience in {sector.label}`).

**Switching a rule off also stops paying for it.** `dimensionWeight(id, on)` zeroes the weight and
remembers it in `WEIGHT_MEMO`, so turning the rule back on restores what it was. It calls
`renderSettings()` afterwards, because a weight slider that still shows 0.15 after you switched
its rule off is the form lying about the policy. Before this, switching a rule off left
`weights.<dimension>` non-zero, which is an incoherent policy the server refuses with
`The age rule is switched off, so its weight does nothing. Set it to 0.` and the user had no way
to know which control was at fault.

**A rejected save must say what is wrong.** The 400 carries an `issues` array; the page joins the
messages into the save line. `Some settings need fixing: age: The age rule is switched off…` is
useful, `the policy has problems` is not.

**Job stability has no `enabled` flag** in the policy, so its switch is driven by whether
`weights.stability` is above zero. Do not add a flag for it without also teaching the engine to
read it.

## Scrollbars

The app styles `::-webkit-scrollbar` and `scrollbar-color` in its own palette (`#2b313d` thumb,
transparent track, rounded, 10px). The default macOS scrollbars are light and read as a foreign
element inside a dark themed container.

## Clearing, and what a new run does

**Clear** in the Candidates toolbar empties the shortlist without starting a run. It asks with a
second click: the first click arms the button and writes how many candidates are about to go, the
second click within five seconds does it. A native `confirm()` was tried first and rejected, because
inside the desktop app's webview it blocks the whole page and the button reads as frozen. The button
also says `Nothing to clear` when the table is already empty.

A new run replaces the shortlist. Both the folder path and the pasted CV path send `reset: true` with
the request that starts the run, so the server drops the old rows in the same call it accepts the new
ones. The API keeps this explicit rather than destructive by default, so `scripts/bench.ts`, the CLI
and `ingest` stay additive unless the caller opts in.

## Gate chips and column names

**Gate chips show only the gates that candidate was judged on.** A gate the role never asks about is
not a fact about the candidate: `education FAIL` on a role with no degree requirement reads as a
disqualification that never happened. The chips are built from the ids present in the row's own
`dimensions`, so an unasked gate simply has no chip, and when nothing was gated the row is not drawn
at all.

**The sector gate chip is gone.** This app screens for any role, so one preset's gate had no business
being a fixed part of the panel. What the sector question did to a score shows up in the caps and the
review reasons instead, in the role's own words.

**Nothing user-visible is hardcoded to one industry.** The dimension heading comes from the policy:
the food preset's own phrase yields `Food sector depth`, a short phrase like `the logistics sector`
yields `Logistics sector depth`, and a placeholder or an over-long phrase falls back to the generic
`Sector depth`. The review strings follow the same rule ("frontend development with React or React
Native presence is uncertain"). `sectorPhrase()` and `dimensionLabel()` in `compose.ts` are the two
places that decide this.

**Table columns come from the rows.** `dimensionColumns()` unions the dimensions the loaded candidates
actually carry, in the order the engine scored them, then adds any extra field the policy switches on.
A role with no degree requirement therefore has no education column, and a heading never falls back to
an internal id such as `military`.

**A re-score also refreshes the wording.** `recomposeAll()` compares the stored result's dimension
labels, review reasons, caps and notes as well as its numbers, so renaming a sector or rewording a
reason reaches every stored row without any inference. Without that check a row whose numbers came out
identical kept the old words forever, which made the change look like it had done nothing.

## The detail panel

**How each part was judged** renders one `.dim-bar` per dimension. The fill's width is the value
itself, so 1.00 fills the track and 0.00 leaves it empty, and the number is shown as a percentage
next to the bar. Two things to keep in mind when touching it:

- **The fill must stay `display: block`.** As an inline span it silently ignored both its width
  and its height, so every bar in this panel rendered empty whatever the value was. The table's
  small bars (`.mini i`) already had `display: block`, which is exactly why the tiny ones looked
  right and the big ones never filled.
- **A value above zero never renders as zero width** (`Math.max(1.5, pct)`), so a genuinely low
  score reads as a small bar rather than as missing data.

**What we asked, and what Jev answered** renders one `.pw` grid row per question through
`questionRow(qid, q, a)`: the question id in monospace with its instruction on the left, the answer
through `answerView` in the middle, and the question type and its size on the right. `answerView`
prints a yes/no as "Yes" or "No" with the chance of yes and a slider, an options question as the
chosen option with its confidence then the distribution beneath, and a rating as "2.99 of 5" with
the mass on each level. Bars come from `probRows`: width is the probability, the chosen answer is
in the accent colour and the rest are neutral grey, because a small number is not a warning. No
JSON and no internal type names reach the screen: a yes/no question is labelled "Yes or no".
