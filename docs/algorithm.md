# Routing algorithm

How AI Model Router decides which model answers a request. Everything below is
implemented. File references point at the code that does it.

```
prompt
  │
  ├─ classify            lib/taskClassifier.ts     → task type + confidence
  ├─ estimate complexity lib/complexityEstimator.ts → 0-1 difficulty score
  ├─ weight              lib/router.ts             → cost/latency/task/quality weights
  ├─ constrain           lib/router.ts             → drop models that are not capable enough
  ├─ score and rank      lib/router.ts             → ordered candidate list
  ├─ execute             lib/chatExecution.ts      → primary → backup → emergency
  └─ record              lib/db/requests.ts        → cost, latency, decision
```

---

## 1. Task classification

`lib/taskClassifier.ts` labels each request as one of: `coding`, `debugging`,
`math_reasoning`, `reasoning`, `writing`, `email`, `summarization`,
`translation`, `data_analysis`, `planning`, `customer_support`, `image`,
`agent_step`, `chat`.

A keyword heuristic runs first. A strong match starts at 0.85 confidence.
Additional strong matches add 0.05 and weak matches add 0.04. With only weak
matches, confidence starts at 0.55 and each extra match adds 0.08. Scores cap
at 0.98. No match returns `chat` at 0.3 confidence.

Below 0.7 confidence, any category can escalate to `gpt-4o-mini` with a
JSON only prompt and a 5 second timeout. This needs an OpenAI key and is
disabled by `AI_MODEL_ROUTER_OFFLINE=1`. Errors fall back to the heuristic.
Successful classifications are cached in memory for one hour, up to 500 entries.
This extra classifier call can incur a charge. Its tokens are not included in
the routed completion cost estimate.

`/v1/agent-step` skips classification entirely. The task type is `agent_step`
by definition.

The result carries the method that produced it: `heuristic`, `llm`, `fallback`,
`cache`, or `forced`. Where no classifier call was possible, offline mode or no
OpenAI key, the keyword result is reported as `heuristic` with its own
confidence. `fallback` is reserved for a call that was made and did not produce
a usable answer. The dashboard request log shows the method, so a decision can
be audited later.

## 2. Complexity estimation

`lib/complexityEstimator.ts` scores difficulty on 0 to 1 from three signals, read
two ways, with a per task floor.

```
length      = 1 − e^(−words / 150)
constraints = requirement markers ("must", "edge cases", "don't" and so on), saturating at 5
hardness    = hard-technical markers ("prove", "distributed", "concurrent" and so on), saturating at 3

combined    = 0.30·length + 0.35·constraints + 0.35·hardness
intrinsic   = 0.55·hardness + 0.45·constraints

complexity  = max(taskBaseline, combined, intrinsic)
```

The two readings exist because length measures how much someone wrote, not how
hard the work is. Under a single weighted average, a terse "make this scalable
and secure under concurrent load" sits at its task baseline, below every tier
where constraints filter out weak models, while a long, rambling, trivial
request scores higher. `intrinsic` ignores length so difficulty markers can stand on
their own. `combined` still rewards a request that is long *and* demanding *and*
technical. The debug endpoint names which reading produced the score.

The baseline is the floor below which a task type cannot fall, because some
work is inherently non trivial regardless of how briefly it is described.

| Task | Baseline | Task | Baseline |
|------|----------|------|----------|
| `math_reasoning` | 0.50 | `writing`, `image` | 0.30 |
| `coding`, `debugging` | 0.45 | `translation` | 0.25 |
| `reasoning`, `data_analysis` | 0.40 | `email`, `summarization` | 0.20 |
| `planning`, `agent_step` | 0.35 | `customer_support`, `chat` | 0.15 |

The result is clamped to [0, 1].

Measured on this build, through `POST /v1/router/debug`:

| Prompt | Task | Score | Decided by |
|--------|------|-------|------------|
| "write a Python quicksort" | `coding` | 0.45 | the coding baseline, no other signal |
| "Make this scalable, secure and production ready under concurrent load" | `chat` | 0.55 | difficulty markers alone, despite being one line |
| "Refactor this parser so it must handle concurrent access, ensure performance under load, and cover edge cases in the tokenizer algorithm." | `coding` | 0.82 | `intrinsic`, at 0.55·1.00 + 0.45·0.60 |

The third is what moves a request past the hard coding tier below, and it takes
both readings of the prompt to get there: three difficulty markers saturate
`hardness`, and three requirement markers carry `constraints` to 0.60, while
`length` contributes 0.13 and never decides anything.

Difficulty markers on their own stop at 0.55, because `intrinsic` weights them
0.55. A prompt naming hard problems without saying what it requires is
therefore not enough to reach the ≥ 0.7 tiers, which is deliberate: those tiers
exclude models, and a request that has not stated a requirement has not yet
shown that a cheaper model would fail it.

## 3. Dynamic weighting

Scoring weights start from the requested priority.

| Priority | cost | latency | task | quality |
|----------|------|---------|------|---------|
| `cheap` | 0.70 | 0.20 | 0.10 | 0.00 |
| `balanced` | 0.40 | 0.30 | 0.30 | 0.00 |
| `best` | 0.10 | 0.20 | 0.40 | 0.30 |
| `quality` | 0.05 | 0.15 | 0.30 | 0.50 |

Complexity then bends them, because the cost of choosing badly is not symmetric.
A weak model on a hard task wastes the whole request, while a strong model on a
trivial one only wastes a fraction of a cent.

```
complexity ≥ 0.7:  task ×1.4  quality ×1.3  cost ×0.6  latency ×0.7
complexity ≤ 0.3:  cost ×1.3  latency ×1.2  task ×0.8  quality ×0.7
latency_pref=fast: latency ×1.5  cost ×0.8
```

Weights are renormalised to sum to 1, so they stay comparable across requests.
`POST /v1/router/debug` returns the exact weights used.

## 4. Hard constraints

Weights alone can let a cheap model win a hard task if the price gap is large
enough. Constraints are applied first, as a filter, and they are not negotiable.

| Task | Complexity | Min task skill | Min reasoning | Hard coding capable |
|------|-----------|----------------|---------------|---------------------|
| `coding`, `debugging` | ≥ 0.7 | 70 | 72 | Required |
| `coding`, `debugging` | ≥ 0.5 | 55 | 60 | Not required |
| `reasoning`, `math_reasoning` | ≥ 0.65 | 70 | 75 | Not required |
| `reasoning`, `math_reasoning` | ≥ 0.4 | 55 | 65 | Not required |
| `data_analysis` | ≥ 0.6 | 65 | 70 | Not required |

Task skill is estimated from the catalog. A model that lists the task in its
`strengths` scores its full `quality_rating`, one that does not is penalised to
70 percent of it. Hard coding capable means the model lists `coding` and rates ≥ 80.

A model context window is a hard filter of its own, applied before the table
above. A model is only a candidate if its `max_tokens` covers the estimated
prompt *plus* the reply the request expects. A model with no published window is
not excluded. An unknown limit is not evidence of a small one, and the provider
will reject the call honestly if it turns out to be too small.

If constraints exclude every model, the request fails with `422
no_capable_model` rather than silently downgrading to something unsuitable. If
nothing was excluded on capability but the conversation is larger than every
window this instance can reach, it fails with `422 context_length_exceeded`
naming the size and the largest window, because that is a different problem
with a different fix.

## 5. Scoring

Surviving candidates are normalised within the candidate set, cost and latency
inverted so lower is better, and scored.

```
score = w_cost·costNorm + w_latency·latencyNorm + w_task·taskMatch + w_quality·(quality/100)
```

`taskMatch` scores 1 when the model lists this task in its strengths, 0.5 when
it lists general `chat` instead, and 0 otherwise. Cost uses the estimated cost
for this request token count, not the per token list price, so a cheap model
with a small context does not look artificially good on a long prompt.

The score is then adjusted by measured provider health, section 7. `priority: cheap`
short circuits the ranking and sorts by estimated cost directly. The other
modes sort by score with quality and latency as tie breakers.

The catalog is cached in memory for five minutes to keep routing off the hot
path of a database read.

## 6. Fallback

`lib/fallback.ts` picks the chain by *why* the previous attempt failed, since
the right recovery differs.

| Failure | Backup | Emergency |
|---------|--------|-----------|
| rate limit | a different provider | cheapest reliable |
| timeout | the fastest remaining model | second fastest |
| anything else | highest quality remaining | cheapest reliable |

`lib/chatExecution.ts` walks primary, backup, emergency, remaining
candidates. The level that answered is returned as `fallback_level` and stored
with the request, so fallback frequency is measurable rather than assumed.

At most four models are attempted per request, on both paths,
`MAX_MODELS_ATTEMPTED` in `lib/fallback.ts`. Selection returns every eligible
model, which for an easy prompt is the whole catalog, and trying all of them
made the worst case grow with the catalog rather than staying a property of
the router: eleven curated models take about 24 minutes to fail one at a time
at the provider deadline, and a dozen custom providers push it past 49. Four
covers the named chain with one spare. Beyond that a fourth failure says the
account, the key or the network is the problem, and a fifth model does not
fix any of those. Ranking still considers the whole catalog, and the decision
records the top five it considered.

Every completion gets the same deadline on both paths, 60 seconds for the
HTTP call inside a 65 second wrapper, with one retry. The constants live in
`lib/providerClient.ts`. A hard reasoning prompt is exactly what this
algorithm routes to its slowest and strongest models, so a shorter deadline
fails the request rather than the model. One retry covers a dropped
connection without spending the deadline three times on a model that is
simply slow. A whole request can therefore outlast a caller's own timeout
when several candidates are tried in turn.

Both paths stop when the caller hangs up, and so does boost, which fans out
the most calls of anything here. Every remaining candidate is another
billable call for an answer nobody will read, so a closed connection ends the
walk, stops each sub task escalating through its own fallback chain, and
skips synthesis. A boost run that ends this way does not fall back to normal
routing either, since that would start the whole walk again. The call already
in flight is finished or abandoned by its own deadline, and a request that
ended this way is not recorded as a failure, because no model refused it and
none failed.

Two outcomes stop the walk instead of continuing it. An explicit refusal or
safety block is the provider answer, so it is returned as `422 provider_refused`
rather than re asked of the next model. A fallback chain that kept going would be
shopping for a model that complies. A 200 carrying no
readable completion is treated as a failed call, not as an empty answer. It
moves to the next model, and it is never recorded as a successful request with
blank output.

Each adapter also validates the usage a provider reports. A count that cannot
be true, negative, fractional, infinite, not a number, is discarded in favour
of the local estimate, because these numbers become recorded costs, savings and
dashboard totals. The database refuses a negative token count, cost or latency
outright.

## 7. Provider health

Each model attempted by the fallback pipeline, including failures, is
written to `provider_attempts` in SQLite after its retry wrapper finishes.
Health aggregates live attempts over the trailing hour. Offline simulations
and legacy attempts with unknown provenance are excluded.

- success rate below 90 percent multiplies the score by `successRate / 0.9`, floored at 0.5
- average latency above 1.5 times the catalog baseline multiplies by `(1.5·baseline) / observed`, floored at 0.7

Fewer than five attempts, with none of them failed, leaves the score untouched,
so a provider is never penalised for lack of evidence. A failure inside the
window counts straight away, because a provider that has just failed is the
weaker bet. The multipliers only reorder candidates, they never exclude one, and
the floors cap how far a bad hour can push a provider down. Because the signal
lives in the database rather than in memory, it survives restarts without an
external cache.

## 8. Boost pipeline

With `boost: true` and complexity ≥ 0.5, `lib/boostPipeline.ts` runs a
three stage pipeline instead of a single call.

1. **Decompose**: a manager model splits the request into up to five independent
   sub tasks with their own task types, or one when splitting is unnecessary.
   Plans are validated for required fields, supported types, and unique IDs
   before any workers run.
2. **Execute**: each sub task is routed through the normal pipeline above, in
   parallel, so a sub task that is really summarisation gets a cheap model even
   when the overall request is hard.
3. **Synthesize**: the manager merges the outputs into one response.

Every stage sees the request system instructions and the earlier turns of the
conversation, not just the last user message: decomposition, each worker, and
synthesis alike. A request that is split into parts is still answered under the
constraints it was made under, and a follow up such as "now implement it" does
not lose the requirement it refers to. Carried history is bounded, most recent
first, so a long thread cannot quietly multiply the cost of every sub task.

If synthesis fails, the sub task outputs are returned concatenated rather than
losing the work. Per sub task model, cost and latency come back in
`boost_details`.

The manager must be in the available catalog. Successful manager and worker
calls use their own catalog prices. Their input and output tokens are summed
in the request log and premium baseline comparison. Total latency includes
decomposition, parallel execution, and synthesis. Costs are estimates. Failed
calls without reported usage and work discarded when boost falls back to normal
routing are not included.

## 9. Where the catalog numbers come from

| Field | Source |
|-------|--------|
| `cost_input`, `cost_output`, `max_tokens`, `supports_functions`, `supports_vision` | OpenRouter public catalog, refreshed in process every 6 hours, but only where the listing describes the same product. Otherwise the config snapshot |
| `strengths`, `quality_rating`, `avg_latency` | `apps/api/config/models.yaml`, maintained by hand |
| `speed_index`, `price_index` | positions within the catalog, recomputed at refresh time from latency and effective pricing. High is fast, and high is expensive. Reported, not scored on |
| `observed_latency_ms` | measured from successful live requests on this instance |

A fetched listing describes OpenRouter's own offer. That is the right source
for an `openrouter` entry, and for a provider's own model under its own
namespace, where OpenRouter passes the first party rate through. It is the
wrong source for a provider that hosts open weights itself, because the same
model id on OpenRouter is a different host, and a host sets its own price, its
own context window and its own tool support. Those entries take nothing from
the listing and report `data_source: config`.

`quality_rating` is a maintainer estimate on a 0 to 100 scale, not a benchmark
result. It is the most subjective input to routing. It lives in one small
version controlled file, and changing it is a pull request.

## Known limitations

- Classification is heuristic first. LLM escalation can apply to any category below the confidence threshold
  and needs an OpenAI key.
- Cost estimates use token count estimation before the call, so pre call
  `max_cost` filtering is approximate, and so is context window filtering,
  which uses the same estimate. Recorded cost uses the provider reported
  usage where it is present and plausible, and the local estimate otherwise.
- Provider health is per instance. Two instances do not share observations.
- Savings are computed against a fixed premium baseline,
  `PREMIUM_ESTIMATE_PER_1K_IN/OUT`, which is a reference point, not a claim
  about what any specific alternative would have cost.
- No response caching. `/v1/chat/completions` supports buffered SSE for compatible
  clients. It emits the answer after upstream generation completes.

## OpenAI compatible routing

`/v1/chat/completions` uses heuristic task classification and the same model
scoring function. It filters for context size and tool support, then attempts
the remaining models in score order. Tool conversations exclude Gemini because
its tool thought signatures cannot be passed losslessly through this client
contract. Provider credentials resolve from the environment first, then the
encrypted Settings vault. Calls and their routing decisions share the request
ID used by the standard completion envelope and dashboard log.
