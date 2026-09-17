# Frozen API contract for the Jev CV screening app

The server is `src/server.ts` (node:http, zero dependencies, port 8799). The UI is a
single file `public/index.html` (vanilla JS, no build step, no CDN, runs offline).

Everything here is a contract: the UI may rely on it, the backend must deliver it.

## 1. GET /api/meta

```json
{
  "app": { "name": "Jev CV Screening", "version": "0.2.0" },
  "model": { "id": "jev-1.13.0", "label": "jev-latest" },
  "hasKey": true,
  "keySource": "/Users/x/typesafe-jev/cv-screen/.env",
  "policy": { "…": "the Policy object, see §6" },
  "fieldLibrary": [ { "id": "career_progression", "label": "Career progression", "help": "…", "kind": "choice", "…": "…" } ],
  "store": { "candidates": 12, "screened_at": "2026-09-17T09:12:00.000Z" },
  "limits": { "maxUploadMb": 64, "defaultConcurrency": 4 }
}
```

`fieldLibrary` entries are ready-made fields the user can switch on. Each has
`id, label, help, source, kind ("noul"|"choice"|"score"), mode, weight, note, enabled`,
plus `definition`: the complete field, with its `instructions`, its `criteria` (levels for
a score, options for a choice), its `choiceValues` and its `reviewWhen`.

A client that switches a field on must save that `definition` into the policy, not the card
text around it. Saving the card text alone is rejected as `extraFields.<id>: Write the
instruction the model should follow.`, because a field with no instruction and no levels
cannot be judged. The server also repairs a library field that arrives without its judgment
(`hydrateLibraryField`), so this round trip cannot fail that way twice.

## 2. GET /api/candidates

```json
{
  "rows": [{
    "id": 41,
    "name": "Nikolaos Papadopoulos",
    "email": "",
    "sourceFile": "75a113e9b959_Nikolaos_Papadopoulos_CV.pdf",
    "createdAt": "2026-09-17T09:12:00.000Z",
    "composite": 0.931,
    "rawComposite": 0.931,
    "capped": false,
    "appliedCaps": [],
    "recommendation": "INTERVIEW",
    "needsReview": false,
    "reviewReasons": [],
    "gates": { "educationAccepted": true, "foodSectorPresent": true, "stabilityRedFlag": false },
    "flags": { "priority": true, "priorityP": 0.99 },
    "dimensions": [{
      "id": "experience_years", "label": "Experience", "weight": 0.2,
      "value": 1, "contribution": 0.2, "basis": "level 3: 3 years or more",
      "unknown": false, "confidence": 0.94, "kind": "score", "answer": "3"
    }],
    "fields": { "career_progression": "steady_growth", "technical_depth": "5" },
    "elapsedMs": 2840,
    "tokens": 3597,
    "model": "jev-1.13.0",
    "stale": false
  }],
  "stats": {
    "candidates": 12, "interview": 3, "maybe": 4, "pass": 5, "needsReview": 2,
    "avgMs": 2810, "avgTokens": 3580, "totalTokens": 42960,
    "fields": [{ "id": "career_progression", "label": "Career progression", "histogram": [["steady_growth", 4], ["job_hopping", 3]] }]
  }
}
```

`dimensions` is ordered: the six core dimensions first, then enabled extra fields, in
policy order. `value` is 0..1 (what the bar shows), `weight` is the declared weight.
`contribution` values sum to `rawComposite`.

`stale: true` means this candidate has no answer for a question the current policy
asks, so its score is provisional until it is re-scanned.

## 3. GET /api/candidates/:id

`{ "row": {…as above…}, "result": {…full ScreenResult…}, "answers": {…raw typed answers…}, "questions": {…the exact questions sent…}, "state": {…the state sent…}, "usage": {"input_tokens":n,"output_tokens":n}, "policy": {…policy used at judgment time…} }`

## 4. Screening

- `POST /api/screen` body `{ "cvText": "…", "name": "…", "email": "…" }` → same body as
  `/api/candidates/:id` plus `{ "elapsedMs": n, "cvChars": n }`.
- `POST /api/batch` body `{ "files": [ { "name": "cv.pdf", "pdfBase64": "…" } | { "name": "cv.txt", "text": "…" } ], "concurrency": 4 }`
  → `{ "jobId": "b_1a2b" }`, then stream progress.
- `GET /api/batch/stream?jobId=b_1a2b` → `text/event-stream`, one JSON object per
  `data:` line:

```json
{"type":"job","jobId":"b_1a2b","total":300,"concurrency":4,"startedAt":"…"}
{"type":"progress","done":37,"failed":1,"total":300,"ms":41230,"elapsedMs":[2810,3020],"tokens":131000,"current":"cv_037.pdf","row":{"…the row object from §2…"}}
{"type":"done","done":299,"failed":1,"total":300,"wallMs":241000,"tokens":1060000,"stats":{…§2 stats…},"errors":[{"file":"cv_104.pdf","error":"extraction failed"}]}
```

Also `{"type":"error","error":"…"}`. The UI shows a live header: progress bar,
`screened/total`, CVs per minute, average ms, average tokens, estimated time left.
Rows arrive as they finish so the table fills live.

- `POST /api/rescan` body `{ "only": "stale" }` → `{ "jobId": "…" }`, same SSE stream.
  Re-runs inference for candidates whose stored answers are missing a question the
  current policy asks. Never re-runs a candidate that is already complete.

## 5. Policy editing

- `PUT /api/policy` body `{ "policy": {…§6…} }` → 

```json
{ "saved": true, "savedAt": "…", "requiresInference": 0, "rescored": { "n": 12, "ms": 3, "tokens": 0 } }
```

`rescored` matters: it is the point of the whole design. Weights, caps and thresholds
are plain code over stored judgments, so changing them re-scores every stored candidate
with zero API calls. The UI must say so, in those terms: **"12 candidates re-scored in
3 ms, 0 tokens"**. `requiresInference` counts candidates whose stored answers do not
cover the new policy, so the UI can offer to re-scan just those.

- `DELETE /api/candidates` (query `?confirm=yes`) → `{ "deleted": 12 }`
- `GET /api/export.csv` → `text/csv`, UTF-8 **with a BOM** so Greek text opens right in
  Excel. One row per candidate, columns: name, file, score, verdict, needs review, then
  one column per dimension in policy order (header = dimension label), the review
  reasons, ms and tokens.

## 6. The Policy object (single source of truth for questions + arithmetic)

```json
{
  "id": "food-industry-qa",
  "roleTitle": "Food industry (QA / R&D / production)",
  "minExperienceYears": 3,
  "acceptedEducation": [
    { "key": "food_chemistry", "label": "Chemistry, food specialisation", "match": "Χημικός με κατεύθυνση Τροφίμων…" }
  ],
  "educationNoMatchKey": "other_not_accepted",
  "weights": { "experience_years": 0.2, "education": 0.2, "food_sector": 0.2, "age_over_28": 0.15, "military": 0.1, "stability": 0.15 },
  "caps": { "educationNotAccepted": 0.5, "noFoodSector": 0.55 },
  "unknownCredit": 0.47,
  "stability": { "maxEmployers": 3, "windowYears": 4 },
  "priorityKeywords": ["RnD", "R&D"],
  "thresholds": { "interview": 0.75, "maybe": 0.5 },
  "review": { "minConfidence": 0.6, "borderlineLow": 0.35, "borderlineHigh": 0.65 },
  "rejectingGates": ["education"],
  "age": { "minAge": 28, "enabled": true },
  "military": { "enabled": true, "fullCreditIfNotApplicable": true },
  "sector": { "enabled": true, "label": "Food sector", "question": "Has this candidate ever worked in the food sector…" },
  "extraFields": [ { "…field spec, see below…" } ],
  "presets": "not part of the object; presets come from /api/presets"
}
```

`extraFields` is an ordered list, each:

```json
{
  "id": "technical_depth",
  "label": "Hands-on technical depth",
  "kind": "score",
  "mode": "weight",
  "weight": 0.15,
  "instructions": "Rate hands-on engineering depth…",
  "criteria": ["0: …", "1: …", "…"],
  "choiceValues": { "steady_growth": 1, "lateral_moves": 0.7, "job_hopping": 0.35, "unclear": 0.47 },
  "enabled": true,
  "reviewWhen": { "options": ["unclear"], "noulAbove": 0.65 }
}
```

- `kind`: `"noul"` (yes/no probability), `"choice"` (one of `criteria` keys),
  `"score"` (ordered `criteria` array, index 0..n-1).
- `mode`: `"weight"` counts in the composite, `"flag"` never changes the score (it is a
  column and can still route to a human).
- For `choice`, `choiceValues` maps option key → 0..1 credit. For `score`, credit is
  `index / (levels - 1)`, so the highest level is full credit.
- `reviewWhen.options` lists choice options that always route to a human review
  (for example `unclear`).

Weights are declared in absolute terms; the engine normalises by the sum of enabled
weights, so adding a field never silently rescales the others.

## 7. UI requirements

- Single file `public/index.html`, vanilla JS + CSS, no CDN, no build step. It must work
  with the machine offline, so no external fonts or scripts.
- Three tabs, plain language, no jargon: **Screen**, **Candidates**, **Settings**.
- A header that is always visible: verdict counters (Ready to interview / Maybe / Pass
  / Needs review), CVs screened, average ms per CV, CVs per minute, tokens, and the
  model id. During a batch it shows live progress + ETA.
- Screen tab: one drop zone that accepts a single PDF, many PDFs, or a whole folder
  (`webkitdirectory` picker plus folder drop), a paste-text box, and the role preset
  picker. Big primary button. Nothing technical on screen.
- Candidates tab: an Excel-like table (sticky header, sortable by clicking a column,
  filters as chips: All / Ready to interview / Maybe / Pass / Needs review, a search
  box, CSV export button). Clicking a row opens a detail panel: score, verdict, the
  dimension bars with the model's own words for each judgment, the gates, the review
  reasons, the raw typed answers and the exact questions that were sent.
- Settings tab: plain-language form. Role title, minimum years of experience, accepted
  degrees as removable chips, age / military / sector toggles, weights as sliders with
  the plain label next to each, thresholds, then **Extra fields**: cards from
  `fieldLibrary` with on/off switches, and an "Add your own field" builder (label, kind,
  weight, instructions, and either options or ordered levels, all editable as text).
  A sticky footer shows: **Save and re-score** (with the "0 tokens" promise), and
  "Re-scan N candidates" when `requiresInference > 0`.
- Greek text must render correctly everywhere (names, review reasons, CSV column
  headers go through the server, not the browser).
- Plain, warm, non-technical wording. Never expose "composite", "normalized weight",
  "noul" or "score question" to the user: say "match score", "weight", "yes/no question",
  "rating question".
