# TypeSafe / Jev — Reference Notes for the Batch CV-Screening App

Distilled from the live docs at https://docs.typesafe.ai (fetched 2026-09-17). Every claim carries its source URL. Where the docs do not cover something, it is marked **NOT FOUND IN DOCS** — nothing here is invented.

---

## (a) Career-progression / job-history question patterns

### The exact "career progression" question (steady growth / lateral moves / job hopping / unclear)
**NOT FOUND IN DOCS.** I searched `llms.txt`, `demos.md`, every cookbook in the index, all patterns/primitives/concepts pages, the agent skill, the GitHub `typesafe-ai/skills` repo, the `typesafe-ai` GitHub org, and the open web. No TypeSafe doc or demo contains a question with the options `steady growth / lateral moves / job hopping / unclear`. If you saw it in a TypeSafe demo, it was likely a user-created Playground share (https://console.typesafe.ai/playground) or a Loom video, not a published doc page. The closest documented hiring examples are below.

### Closest documented analog — resume screening (composite scoring)
`https://docs.typesafe.ai/patterns/composite-scoring.md` — "Example: resume screening" for engineering roles. It scores 4 independent dimensions as **Score** questions, each with **5 ordered levels (0..4)**, then combines them with weights in code. The `generalist` dimension is the closest thing to a career-trajectory judgment (it rates moving between domains/roles). Verbatim question JSON (extracted from the page's embedded example):

```json
{
  "python_depth": {
    "type": "score",
    "instructions": "How much depth of python experience does this candidate have, based on the supplied resume?",
    "criteria": [
      "No Python experience mentioned",
      "Mentioned but no detail",
      "Used in projects, some specifics",
      "Primary language, multiple projects",
      "Deep expertise: architecture, performance, libraries"
    ]
  },
  "team_leadership": {
    "type": "score",
    "instructions": "How much experience does this candidate have managing or leading engineering teams?",
    "criteria": [
      "No management experience mentioned",
      "Informal mentorship or tech lead role",
      "Led a small team or project",
      "Managed a team with direct reports",
      "Managed multiple teams or an engineering org"
    ]
  },
  "system_design": {
    "type": "score",
    "instructions": "How much experience does this candidate have designing large-scale or distributed systems?",
    "criteria": [
      "No architecture work mentioned",
      "Contributed to design discussions",
      "Designed components of a larger system",
      "Owned architecture of a significant system",
      "Designed systems at scale across multiple domains"
    ]
  },
  "generalist": {
    "type": "score",
    "instructions": "How much evidence is there that this candidate picks up unfamiliar tools, roles, or domains outside their core specialty?",
    "criteria": [
      "Only one domain or role mentioned",
      "Some variety but within a narrow field",
      "Worked across a few different areas or tech stacks",
      "Regularly moved between domains, wore many hats",
      "Track record of ramping up in unfamiliar areas and delivering"
    ]
  }
}
```

The combining code (same page) normalizes each score to 0–1 by dividing by the top level (`score / 4`), then weights:

```python
py      = response.answers["python_depth"].score / 4
lead    = response.answers["team_leadership"].score / 4
arch    = response.answers["system_design"].score / 4
general = response.answers["generalist"].score / 4

# Senior IC
ic_score = (0.40 * py) + (0.10 * lead) + (0.40 * arch) + (0.10 * general)
# Engineering Manager
em_score = (0.15 * py) + (0.40 * lead) + (0.20 * arch) + (0.25 * general)
```

### HR / recruiting use cases (no JSON, just guidance)
`https://docs.typesafe.ai/concepts/use-case-map.md` — Human Resources section:
> Evaluate resumes, applications, and interview feedback against explicit, job-related criteria. Identify relevant experience. Score evidence for required competencies. Match candidates to roles. Route candidates to hiring managers or recruiters. Escalate uncertain cases for human review.

### Resume-related Noul examples
- `https://docs.typesafe.ai/primitives/noul.md` — example Noul: `"Does this resume mention experience with distributed systems?"`
- `https://docs.typesafe.ai/primitives.md` — "does the resume mention distributed systems" is given as a Noul example; and "Is this candidate strong in Python?" is explicitly flagged as needing a clear definition (use a Score, not a Noul).

---

## (b) Design guidance for ordered Score levels (0..5) and "when torn" handling

### Score mechanics
- `https://docs.typesafe.ai/primitives/score.md` — `criteria` is an **ordered array of level descriptions, low end → high end**. Needs **at least 2 levels, up to 10**. A level's number is its 0-indexed position in the array. The returned `score` is a position along the levels and **can land between two levels** (e.g. 1.6 on a 0..2 scale). The model gets the descriptions and nothing else; each level is judged on its own against the state.
- `https://docs.typesafe.ai/api.md` — Score answer shape: `{ "type":"score", "score":1.6, "legend":{"0":"Calm","1":"Frustrated","2":"Very angry"}, "probabilities":{"0":0.05,"1":0.3,"2":0.65}, "confidence":0.78 }`.
- `https://docs.typesafe.ai/primitives/score.md` — example Score rubrics include a 5-level "formality" scale (0 gym clothes → 4 black tie) and a 4-level "candidate relevance" scale (0 completely unrelated → 3 deep, direct experience). A 5-level (0..4) scale is exactly what the resume-screening example uses (see section a).

### Structured level descriptions (use when the model keeps landing between two levels)
`https://docs.typesafe.ai/primitives/score.md`:
> Start with a basic text description for each level. When the model keeps scoring between two neighbouring levels on inputs you think are clear, give each level an object instead of a string, with a field for what the level covers and a field with a few example situations. Use the same field names on every level so the model can compare like with like.

Example (same page) — level objects with `what` + `examples`:
```json
"criteria": [
  { "what": "Cosmetic; no impact to functionality", "examples": ["typo in a label", "misaligned icon"] },
  { "what": "Broken or degraded feature, but workaround exists", "examples": ["export fails in one browser but works in another"] },
  { "what": "Blocking issue; no workaround exists", "examples": ["cannot log in", "data loss"] }
]
```
The page reports that adding a *matching* example raised confidence from 0.54 → 0.90, while an *unrelated* example barely helped (0.57). **Examples only help when they look like your real inputs.** Higher confidence does not establish which answer is correct — test revised descriptions on separate inputs.

### "When torn, pick the lower level" instruction
**NOT FOUND IN DOCS.** No TypeSafe doc contains a "when torn between two levels, pick the lower one" style instruction. The documented remedies for between-level ambiguity are (1) structured level objects with examples (above), and (2) reading `confidence`/`probabilities` to decide whether to escalate (see section d). If you want a conservative bias, you must encode it yourself in code (e.g. floor the score, or treat low confidence as "route to human").

### Noul vs Score for skill-level judgments
`https://docs.typesafe.ai/primitives.md` and `https://docs.typesafe.ai/primitives/noul.md`:
> "Is this candidate strong in Python?" needs a clear definition of "strong". A Noul value of 0.5 means the model gives yes and no equal probability. It does not mean the candidate has a medium skill level. ... If you want to measure skill level, use a Score with defined levels, such as no experience, some familiarity, daily use, and deep expertise.

This is the direct precedent for your user-editable "technical depth 0–5" custom field: model it as a Score with 5–6 ordered, concrete level descriptions.

---

## (c) API, limits, and models

### Endpoint
`https://docs.typesafe.ai/api.md` and `https://docs.typesafe.ai/introduction/quickstart.md`:
```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <key>
Content-Type: application/json
```
The old preview endpoint `POST /preview/evaluation` is replaced by v1 (`/v1/systemone`); the request field is `state` (not `document`), and `questions` is a map (not a `prompts` array). `https://docs.typesafe.ai/migrating-to-v1.md`.

### Request body
`https://docs.typesafe.ai/api.md`:
```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "model": "jev-latest",
  "questions": {
    "is_urgent": { "type": "noul", "instructions": "Does this convey urgency?" }
  }
}
```
- `state`: a plain string, a JSON object, or an array of text values (or `null`). Jev accepts **text only** — no images/audio/video. `https://docs.typesafe.ai/concepts/state.md`.
- `model`: optional; SDKs default to `jev-latest`. `https://docs.typesafe.ai/sdk/python/api/constants.md`.
- `questions`: a **nonempty** map; each key is an id you choose (not sent to the model), each value is a typed question. `https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneRequestPayload.md`.

Question shapes (`https://docs.typesafe.ai/api.md`):
- **Noul**: `{ "type":"noul", "instructions": "...", "criteria?": {"true":"...","false":"..."} }`
- **Choice**: `{ "type":"choice", "instructions":"...", "criteria": {"option":"description", ...} }` (use `null` for an option needing no detail)
- **Score**: `{ "type":"score", "instructions":"...", "criteria": ["level0","level1",...] }`

`instructions`, Choice option descriptions, Score level entries, and Noul `true`/`false` can each be a string, object, array, or null (structured criteria). `https://docs.typesafe.ai/primitives/advanced.md`.

### Response body
`https://docs.typesafe.ai/api.md`:
```json
{
  "model": "jev-latest",
  "answers": {
    "is_urgent": { "type": "noul", "noul": 0.92 }
  },
  "usage": { "input_tokens": 312, "output_tokens": 48 }
}
```
- **Noul answer**: `{ "type":"noul", "noul": <0..1> }` — no separate confidence.
- **Choice answer**: `{ "type":"choice", "choice":"technical", "probabilities":{"billing":0.08,"technical":0.85,"sales":0.07}, "confidence":0.82 }`
- **Score answer**: `{ "type":"score", "score":1.6, "legend":{"0":"Calm","1":"Frustrated","2":"Very angry"}, "probabilities":{"0":0.05,"1":0.3,"2":0.65}, "confidence":0.78 }`
- `usage` reports `input_tokens` / `output_tokens` (v1; preview used a `billing_units` placeholder). `https://docs.typesafe.ai/migrating-to-v1.md`.

### Models (is `jev-latest` real? yes)
`https://docs.typesafe.ai/models.md`:
- **Current model**: `jev-1.13.0` (Jev 1.13). Price **$42 per Btok = $0.042 per Mtok, charged per input token; output tokens are free**. Rate limits **250,000 tokens/second and 1,200 requests/minute**; a request over either limit returns `429`.
- **Aliases** (send in the `model` field):
  - `jev-latest` → `jev-1.13.0` (most recent stable official release; the default in SDKs and all doc examples)
  - `jev-preview` → `jev-1.13.0` (currently same as latest; no preview build available)
- Versioned IDs such as `jev-1.13.0` are accepted whether or not they appear in the list. `GET /v1/models` lists the aliases your account can use.
- **Rate limits are adjusting dynamically** and can change without notice; higher limits on custom/enterprise plans.
- Historical note: cookbooks reference `jev-1.12` (e.g. `https://docs.typesafe.ai/cookbooks/parallel_questions.md` sets `TYPESAFE_MODEL = "jev-1.12"`), so versioned IDs like `jev-1.12.0` existed previously.

### Token budget / request size
`https://docs.typesafe.ai/primitives.md`:
> The number of questions in one request is limited only by the request's token budget, which the state and the questions share. The budget is around 32,000 tokens, roughly 150,000 characters of English text.

There is **no separate documented cap on the number of questions per request** — only the shared ~32k-token budget. **No documented max state size** beyond that budget. **No documented server-side request timeout** (see SDK timeout below).

### Errors and rate limits
`https://docs.typesafe.ai/api.md`:
| Status | Meaning |
|---|---|
| 401 Unauthorized | Missing/invalid API key |
| 422 Unprocessable Entity | Request body failed validation (missing field / malformed question); body details the offending field |
| 429 Too Many Requests | Rate limit exceeded — back off and retry after a short delay |
| 529 Overloaded | TypeSafe temporarily overloaded — retry after a short delay |

SDK exception classes also cover 400, 403, 404, and 5xx, plus connection/timeout errors; the 429 error carries a parsed `retry_after_ms` from the `retry-after` header. `https://docs.typesafe.ai/sdk/python/api/exceptions.md`. Docs recommend **exponential backoff** on 429/529; SDKs do this automatically and honor `retry-after`. `https://docs.typesafe.ai/api.md#handling-rate-limits`.

### Timeouts
`https://docs.typesafe.ai/sdk/python/api/constants.md` — Python SDK `DEFAULT_TIMEOUT = 10.0` seconds per HTTP operation. Cookbooks raise it for large documents: `timeout=30.0` (`https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md`) and `timeout=120.0` (`https://docs.typesafe.ai/cookbooks/parallel_questions.md`).

### Concurrency guidance
**NOT FOUND IN DOCS** as an explicit concurrency policy. The docs give no recommended parallelism level. The only hard constraints are the rate limits (1,200 req/min, 250k tokens/sec) and the SDK default 10s timeout. Cookbooks do use `ThreadPoolExecutor` for parallel calls (`https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md`), and the batching cookbook shows that batching questions into one call beats parallel single-question calls (see section e).

---

## (d) Threshold / confidence guidance

- `confidence` is a 0–1 statistic derived from the answer's `probabilities` distribution (concentration = confidence). It is returned on **Choice and Score answers only; Noul has no confidence**. `https://docs.typesafe.ai/confidence.md`, `https://docs.typesafe.ai/api.md`.
- **Three-range pattern** (`https://docs.typesafe.ai/confidence.md`):
  - **High confidence** → act automatically.
  - **Medium confidence** → proceed with caution (confirm / flag / gather more info).
  - **Low confidence** → do not act; route to a human, request clarification, or fall back.
- **Thresholds scale with risk** — not one number. Examples in the docs: a `0.5` confidence floor for "genuinely unsure" (`https://docs.typesafe.ai/confidence.md`); a `0.6` floor with `>0.85` for high-stakes actions (`https://docs.typesafe.ai/patterns/confidence-routing.md`); `0.3` for "which team" routing and `0.5` for "what does the customer want" (`https://docs.typesafe.ai/primitives/choice.md`); `0.75` topic confidence and a `0.4–0.6` uncertainty band for spam risk (`https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md`).
- **Calibration advice** (`https://docs.typesafe.ai/confidence.md`): "The correct threshold values depend on your domain and the performance of the model for your use case. Start with conservative thresholds, test with your own data, and adjust as you observe results."
- **Noul interpretation** (`https://docs.typesafe.ai/primitives/noul.md`): near 1 = strong yes, near 0 = strong no, near 0.5 = yes and no equally likely (not "medium"). Threshold it into a boolean in code.
- **When not to use confidence** (`https://docs.typesafe.ai/agent-skill.md`): "If all you care about is choosing the best option, you just need to choose the option with the highest confidence (rather than setting a confidence threshold). If you have a specific statistical algorithm in mind, you should probably be using probabilities instead of confidence."
- Low confidence on a Score often means the levels are ambiguous, multi-dimensional, or the state lacks enough to go on — a signal to improve the rubric or the state, not just the threshold. `https://docs.typesafe.ai/confidence.md`.

---

## (e) Batching many items and latency

### One request per item is the model; batch all questions per item
Each request evaluates **one** `state` against one or more questions (`https://docs.typesafe.ai/concepts/state.md`). So for hundreds of CVs the shape is **one request per CV**, with **all of that CV's questions batched into that single request**. The docs do not describe sending multiple documents in one request.

### Batching questions into one call is dramatically cheaper and faster
`https://docs.typesafe.ai/cookbooks/parallel_questions.md` — a 13-question regulatory briefing over a ~54k-char document: batching all 13 questions into one call is **12.2x cheaper and 10.0x faster** than 13 single-question calls, **with no change in answers** (most answers identical across repeats, std dev 0.0 under both strategies). The document dominates every request, so N single-question calls pay for it N times and make N round trips; the batched call pays once. (Note: `https://docs.typesafe.ai/primitives.md` states the same result as "11.5x cheaper and 9.6x faster" — the two pages quote slightly different numbers for the same cookbook.)

### Adding questions does not add latency
- `https://docs.typesafe.ai/patterns/fan-out.md`: "All questions are evaluated in parallel, so adding more questions to a call typically doesn't add any latency to the response."
- `https://docs.typesafe.ai/introduction.md`: "Every question is evaluated in parallel and in isolation against the same state in one go. Adding questions barely changes the response time."
- `https://docs.typesafe.ai/primitives.md`: "Adding questions barely changes the response time because they run in parallel within one request. The split costs a few extra question tokens."

### Latency expectations
- `https://docs.typesafe.ai/concepts/use-case-map.md`: "Frontier intelligence at real-time speeds (150ms)" — the docs' headline latency figure for Jev.
- The parallel-questions cookbook measures per-call latency directly (its `ask()` records `perf_counter()` round-trip time) but the docs do not publish a fixed per-request latency number beyond the ~150ms claim. **NOT FOUND IN DOCS**: a documented per-request latency guarantee or a per-item latency figure for large batches.

### Practical implication for the batch app
For N CVs, expect **N requests**, each carrying all ~10+ questions for that CV, each bounded by the shared ~32k-token budget (a CV's text + all question text must fit). At the documented 1,200 req/min / 250k tokens/sec rate limits, throughput is ample for hundreds of CVs; the docs' only explicit guidance is to batch questions per item and use exponential backoff on 429/529. No documented concurrency ceiling beyond the rate limits.

---

## Source index
- API reference: https://docs.typesafe.ai/api.md
- Models: https://docs.typesafe.ai/models.md
- Primitives: https://docs.typesafe.ai/primitives.md · Score: https://docs.typesafe.ai/primitives/score.md · Choice: https://docs.typesafe.ai/primitives/choice.md · Noul: https://docs.typesafe.ai/primitives/noul.md · Advanced/structure: https://docs.typesafe.ai/primitives/advanced.md
- State: https://docs.typesafe.ai/concepts/state.md · How to build: https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md · Use-case map: https://docs.typesafe.ai/concepts/use-case-map.md
- Confidence: https://docs.typesafe.ai/confidence.md
- Patterns: composite-scoring https://docs.typesafe.ai/patterns/composite-scoring.md · fan-out https://docs.typesafe.ai/patterns/fan-out.md · confidence-routing https://docs.typesafe.ai/patterns/confidence-routing.md
- Cookbooks: parallel questions https://docs.typesafe.ai/cookbooks/parallel_questions.md · consistency-noul https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md
- Migration (v1): https://docs.typesafe.ai/migrating-to-v1.md
- SDK: Python constants https://docs.typesafe.ai/sdk/python/api/constants.md · Python exceptions https://docs.typesafe.ai/sdk/python/api/exceptions.md · JS payload https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneRequestPayload.md
- Agent skill: https://docs.typesafe.ai/agent-skill.md
