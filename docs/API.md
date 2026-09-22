# API reference

For OpenClaw and OpenAI compatible clients, use `POST /v1/chat/completions`.
See [Integrations](INTEGRATIONS.md) for client configuration and tool support.

Example model names, prices, usage, and timestamps illustrate response shapes. They are not current provider pricing or benchmark results. Read the connected catalog and verify provider documentation before configuring live models.

Base URL for a local instance: `http://localhost:3000`.

## Authentication

The demo API accepts requests without a key until a provider or integration key
is configured. After setup, present a router key as `Authorization: Bearer <key>`
or `X-API-Key: <key>`. Create and revoke router keys in Settings. They can call
completion endpoints and list models. Usage history and other dashboard routes
require the administrator key, or the legacy `AI_MODEL_ROUTER_API_KEY`.

`/admin/*` always requires the administrator key from `npm run admin:key` or
`AI_MODEL_ROUTER_ADMIN_KEY`. Provider keys and router keys cannot administer the
router. Credentials are never returned by these endpoints. Newly created
router keys are returned once, with `Cache-Control: no-store`.

`/health` and `/ready` never require a key.

## Errors

```json
{
  "error": {
    "code": "validation_error",
    "message": "messages: Required",
    "details": [{ "path": "messages", "message": "Required" }]
  },
  "request_id": "0f0b..."
}
```

A rejected request names the field that failed rather than reporting that
something was wrong. `message` is the first failure, written as the path
followed by the reason, and `details` carries every failure with its own path,
so a caller sending several bad fields learns about all of them at once. A path
is empty only when the whole body was the wrong shape, and `message` then reads
`request:` instead.

`POST /v1/chat/completions` keeps the OpenAI spelling for this one case: its
code is `invalid_request_error`, repeated in a `type` field beside it, because
compatible clients read that field. The `message` and `details` are the same.

| Code | Status | Meaning |
|------|--------|---------|
| `validation_error` | 400 | Body or query failed schema validation |
| `max_cost_exceeded` | 400 | No model fits the requested `max_cost` |
| `invalid_api_key` | 401 | Missing, wrong, or revoked router key |
| `admin_required` | 401 | Settings requires an administrator key |
| `forbidden` | 403 | A router key cannot access this dashboard endpoint |
| `rate_limited` | 429 | Over `RATE_LIMIT_MAX` in the current window, or too many failed keys from one address |
| `provider_rate_limited` | 429 | Every model this request could use was rate limited upstream. The router is fine, the provider quota is not |
| `no_capable_model` | 422 | Constraints excluded every model in the catalog |
| `context_length_exceeded` | 422 | Prompt plus expected reply is larger than every available context window |
| `provider_refused` | 422 | The model declined or its safety filter blocked the request |
| `provider_error` | 502 | Every model in the fallback chain failed |
| `not_found` | 404 | No such endpoint, key, or custom provider |
| `environment_managed` | 409 | The provider key is set in the server environment, not in Settings |
| `key_limit` | 409 | 50 router keys already exist. Revoke one first |
| `internal_error` | 500 | Unexpected failure. Correlate with `request_id` |

Only one of these is reported for a request that produced no candidate, and the
one reported is the reason it produced none. A conversation too large for every
window is `context_length_exceeded`, not `max_cost_exceeded`. Both completion
paths report the same code for the same cause.

`rate_limited` and `provider_rate_limited` are different problems with the same
status. The first says this router turned the request away. The second says the
router tried and every model it could use was over its provider's quota, so the
request is worth retrying without changing anything.

A `provider_refused` response carries the provider stated `reason` alongside
the message, for example `content_filter`. It is not retried and does not
fall back to another model. The fallback chain exists to survive providers that
are down, not to look for one that will comply.

Rate limited responses carry `x-ratelimit-limit`, `x-ratelimit-remaining` and
`x-ratelimit-reset`. Every response carries `x-request-id`.

Settings requests, and requests that present a key the router does not accept,
are limited to 60 per minute per client address. That budget is separate from
`RATE_LIMIT_MAX`, so a client holding a working key is never slowed by someone
else guessing.

---

## `POST /v1/chat/completions`

OpenAI Chat Completions contract for OpenClaw and other compatible clients.
`model` is `auto`, default, `auto-cheap`, or `auto-best`. Send `messages` with
text content, strings or arrays of `{ "type": "text", "text": "..." }`.
Supported roles: `system`, `developer`, `user`, `assistant`, and `tool`.
Assistant `tool_calls` and tool `tool_call_id` values are preserved. A tool
result must match a preceding assistant call, and all calls need results before
continuing. Tools use `type: "function"` and JSON Schema `parameters`.

Supported options: `tools`, `tool_choice`, `parallel_tool_calls`, `temperature`,
`top_p`, `stop`, `max_tokens`, `max_completion_tokens`, `stream`,
`stream_options.include_usage`, and `n: 1`. The largest output token request
accepted is 32768.
Unknown model aliases, images, invalid tool histories, and multiple completions
are rejected. Gemini currently routes text only in this compatibility endpoint.
Additional provider specific parameters are not forwarded.

User, system, and developer messages must contain non whitespace text. Forbidden
control characters are removed while indentation and other whitespace are
preserved. Empty tool results and assistant messages containing tool calls remain
valid. Blank provider answers trigger fallback. Tool only answers remain valid.
Explicit refusals and safety blocks stop the request with `422 provider_refused`,
without retrying or switching models. When SSE has already started, the same error
is emitted as an event followed by `[DONE]` under the existing HTTP 200 stream.
Invalid usage counts are replaced with local estimates. Provider deadlines cover
the response body, and disconnecting the client cancels the pending attempt.

Adapters normalize supported options to the selected provider. Anthropic uses
temperature up to 1 and avoids sending both temperature and top p. OpenAI o series
reasoning models use `max_completion_tokens` and their fixed sampling defaults.

```json
{
  "model": "auto",
  "messages": [{ "role": "user", "content": "Explain binary search." }]
}
```

The JSON response has `object: "chat.completion"`, `id`, `created`, the actual
provider and model in `model`, `choices[0].message`, `choices[0].finish_reason`, and
`usage` with `prompt_tokens`, `completion_tokens`, and `total_tokens`. `request_id`
matches the saved Requests entry. Standard model discovery is available through
`GET /v1/models`. Its `object: "list"` and `data` array list all three aliases.
The existing dashboard `models` and `catalog` fields are also retained.

With `stream: true`, the server sends `text/event-stream`, keepalive comments,
then `chat.completion.chunk` deltas, a finish reason, optional usage, and
`data: [DONE]`. This is **buffered SSE**, emitted after upstream generation
completes. An error after streaming starts is an SSE `error` object followed
by `[DONE]`. Non streaming provider failures use HTTP 502, or 429 when every
model this request could use was rate limited upstream. The client executes
tools. The router never runs them.

## Administrator settings

All endpoints below require an administrator bearer key and return no store
responses. Keys saved in the environment are read only through the UI and API.

| Method and path | Body and result |
| --- | --- |
| `GET /admin/settings` | Provider configured and source status, router key names and prefixes, offline mode. No secrets |
| `PUT /admin/providers/:provider` | `{ "key": "provider-key" }`. Supported providers: `openai`, `anthropic`, `google`, `openrouter`, `groq` |
| `DELETE /admin/providers/:provider` | Removes the encrypted saved credential. Returns 409 when the provider is managed by an environment key |
| `POST /admin/keys` | `{ "name": "OpenClaw laptop" }`. Returns `id`, `name`, `prefix`, `created_at`, and one time `key` |
| `DELETE /admin/keys/:id` | Immediately revokes that router key. Does not disable authentication |

Saved provider keys are AES 256 GCM encrypted. Key writes validate format only,
not provider balance or model access. Live completion requests verify those
through the provider. See [Security](../SECURITY.md) and [Deployment](DEPLOYMENT.md).

## `POST /v1/chat`

Routes one request and returns the completion.

**Body**

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `messages` | array | required | `{ role: "system" \| "user" \| "assistant", content: string }`, at most 100 |
| `priority` | string | `"balanced"` | `cheap` \| `balanced` \| `best` \| `quality` |
| `latency_pref` | string | `"normal"` | `fast` \| `normal` |
| `max_cost` | number | Unset | Filters estimated completion cost in USD. Cannot be combined with `boost` |
| `boost` | boolean | `false` | Decompose into sub tasks, route each, then synthesize. Skipped when complexity < 0.5 |
| `manager_model` | string | `"ai-model-router-ai"` | Model used for decomposition and synthesis when `boost` is on |

Message content is capped at 100,000 characters and must contain something
other than whitespace once control characters are removed. Both are 400s. What
is left is sent verbatim: indentation, tabs and runs of spaces are content, so
they are never collapsed, and the prompt that is classified, priced and sent is
the one the caller wrote.

**Response 200**

```json
{
  "output": "def quicksort(xs): ...",
  "model_used": "gpt-4o-mini",
  "provider": "openai",
  "task_type": "coding",
  "complexity": 0.45,
  "cost": 0.00031,
  "latency_ms": 420,
  "savings_estimate": 0.0019,
  "fallback_level": "primary",
  "request_id": "0f0b..."
}
```

`savings_estimate` is the difference against a premium only baseline,
`PREMIUM_ESTIMATE_PER_1K_IN/OUT` in `lib/providers.ts`, not a claim about any
particular alternative.

Normal responses also carry `routing`, with the same explanation fields as
`/v1/router/debug`. Its `selected_model` reflects the executed model, including
fallback. The response `request_id` identifies the saved request.

When `boost` runs, its response contains `output`, `model_used`, `cost`,
`latency_ms`, `savings_estimate`, `request_id`, and `boost_details`, which covers
decomposition, per sub task models and costs, and synthesis timings. Normal
routing fields are omitted.
Boost is experimental and does not accept `max_cost`.
Manager overrides must identify a model in the available catalog. Recorded
token usage and estimated cost aggregate successful decomposition, worker,
and synthesis calls. Failed calls without usage and discarded boost work are
not included when the request falls back to normal routing.

## `POST /v1/agent-step`

Identical contract to `/v1/chat`, but the task type is fixed to `agent_step` so
individual steps of an agent loop are routed without re classification.

## `POST /v1/router/debug`

Explains what the router would do without executing the completion. Ambiguous
prompts can make a paid classification call when an OpenAI key is configured.
`AI_MODEL_ROUTER_OFFLINE=1` disables that call as well.

Body is the same as `/v1/chat`, and so is everything before the completion:
the same validation, the same message content, the same token estimate and the
same routing. A body rejected here is rejected by `/v1/chat`, with the same
code. A `max_cost` that fails here fails there.

```json
{
  "task_type": "coding",
  "classification": { "confidence": 0.85, "method": "heuristic", "reasoning": "..." },
  "complexity": { "score": 0.45, "factors": { "lengthScore": 0.06, "...": 0 }, "reasoning": "..." },
  "weights": { "cost": 0.4, "latency": 0.3, "task": 0.3, "quality": 0 },
  "constraints": { "minCategorySkill": 0, "minReasoning": 0, "requireHardCoding": false },
  "considered_models": [{ "provider": "openai", "model_name": "gpt-4o-mini", "score": 0.81 }],
  "selected_model": "openai/gpt-4o-mini",
  "reason": "...",
  "boost_eligible": false,
  "available_providers": ["openai"],
  "offline_mode": false,
  "request_id": "0f0b..."
}
```

## `GET /v1/usage`

Aggregated usage. Optional `from` and `to` ISO timestamps, window capped at 90 days.

```json
{
  "total_requests": 400,
  "total_cost": 1.4968,
  "total_savings": 1.3829,
  "total_tokens": 525462,
  "total_tokens_input": 316664,
  "total_tokens_output": 208798,
  "avg_latency_ms": 754,
  "success_rate": 0.98,
  "by_source": [{ "source": "demo", "requests": 400 }],
  "by_day":   [{ "date": "2026-09-09", "requests": 12, "cost": 0.04, "savings": 0.03 }],
  "by_model": [{ "model": "gpt-4o", "provider": "openai", "requests": 57, "cost": 0.49, "savings": 0.31, "avg_latency_ms": 870 }],
  "by_task":  [{ "task_type": "coding", "requests": 61, "cost": 0.55, "avg_complexity": 0.62 }]
}
```

## `GET /v1/requests`

Recent requests joined to the routing decision that produced them. `limit`
defaults to 50, maximum 200.

```json
{
  "requests": [
    {
      "id": "a6dd...", "created_at": "2026-09-09T04:38:43.537Z",
      "source": "offline",
      "endpoint": "/v1/chat", "task_type": "coding", "complexity": 0.45,
      "provider": "groq", "model_used": "openai/gpt-oss-120b",
      "tokens_input": 12, "tokens_output": 194,
      "cost": 0.0001182, "savings": 0.0018518, "latency_ms": 259,
      "success": true, "fallback_level": "primary", "boost": false,
      "routing": {
        "considered_models": [{ "provider": "groq", "model_name": "openai/gpt-oss-120b", "score": 0.979 }],
        "final_model": "groq/openai/gpt-oss-120b",
        "reason": "...",
        "weights": { "cost": 0.4, "latency": 0.3, "task": 0.3, "quality": 0 },
        "constraints": { "minCategorySkill": 0 },
        "classification_method": "heuristic",
        "confidence": 0.85
      }
    }
  ]
}
```

## `GET /v1/models`

The routable catalog. Optional `provider` filter, which must be a single
non empty value. A repeated `?provider=a&provider=b` is a 400, not a 500.

```json
{
  "models": [
    {
      "id": "openai/gpt-4o-mini", "provider": "openai", "model_name": "gpt-4o-mini",
      "cost_input": 0.00015, "cost_output": 0.0006, "avg_latency": 400,
      "strengths": ["chat", "summarization"],
      "quality_rating": 71, "speed_index": 92, "price_index": 18,
      "supports_functions": true, "supports_vision": true, "max_tokens": 128000,
      "deprecated": false, "data_source": "openrouter",
      "last_synced_at": "2026-09-09T04:00:00.000Z",
      "observed_latency_ms": 412, "provider_configured": true
    }
  ],
  "catalog": { "models": 11, "last_sync_at": 1788928699982, "source": "openrouter", "stale": false },
  "offline_mode": false
}
```

`speed_index` and `price_index` are positions within this catalog on a 0 to
100 scale, not absolute ratings, so both move when a model is added or
removed. A high `speed_index` is fast and a high `price_index` is expensive;
the example above is a model that is both quick and cheap. Routing reads the
underlying latency and price rather than either index.

`avg_latency` is the catalog baseline. `observed_latency_ms` is what this
instance actually measured over the last seven days from successful live
requests. Offline completions, seeded samples, and unknown legacy records are
excluded. `observed_latency_ms` is null when no qualifying traffic exists.

Request `source` is `live`, `offline`, `demo`, or `unknown`, the last being
legacy records whose origin cannot be established. Usage `by_source` respects the same date range
as every other aggregate.

## `GET /v1/providers`

Provider reliability measured from the last hour of live fallback pipeline
attempts, including failures. Each attempt includes its internal retries.
Offline simulations and legacy attempts whose origin is unknown are excluded.

```json
{
  "offline_mode": false,
  "providers": [
    { "provider": "openai", "configured": true, "attempts": 42,
      "success_rate": 0.98, "avg_latency_ms": 612, "failures": 1,
      "last_failure_at": "2026-09-09T04:31:02.000Z" }
  ]
}
```

## `GET /health`

Unauthenticated. Reports how the instance is configured.

```json
{
  "status": "ok",
  "offline_mode": true,
  "providers": [],
  "auth_required": false,
  "catalog": { "models": 11, "last_sync_at": 1788928699982, "source": "config", "stale": false }
}
```

## `GET /ready`

Unauthenticated. `200 {"status":"ok"}` when the database answers, `503` otherwise.

## Custom providers

`GET /admin/settings` includes `custom_providers`. Each has `provider`, `name`, `base_url`, and its catalog `models`. Provider secrets are never returned. All `/admin` endpoints require the administrator key.

`PUT /admin/custom-providers` saves an OpenAI compatible provider and adds or updates one model.

```json
{
  "provider": "custom-example",
  "name": "Example",
  "base_url": "https://api.example.com/v1",
  "key": "YOUR_PROVIDER_KEY",
  "model": {
    "model_name": "example-chat",
    "cost_input": 0.001,
    "cost_output": 0.002,
    "max_tokens": 32000,
    "supports_functions": true,
    "quality_rating": 70,
    "avg_latency": 2000,
    "strengths": ["chat", "coding"]
  }
}
```

Costs are USD per **1,000 tokens** in the API. The dashboard accepts prices per million and converts them. `max_tokens` is the model context window. Quality and latency are operator estimates, not measured benchmarks. Use the exact model ID and published prices and capabilities from your provider. Provider IDs must match `custom-[a-z0-9][a-z0-9-]{0,49}`. Keys can be omitted when updating the same endpoint. A new provider or changed base URL requires a key. Only HTTPS or loopback HTTP endpoints are accepted, without URL credentials, query strings, fragments, or the `/chat/completions` suffix. Redirects are rejected.

`DELETE /admin/custom-providers/:provider` removes the custom provider, its encrypted key, and its catalog models. Request history remains. Saving, updating, and removing take effect immediately. Custom models survive the built in catalog refresh.

Custom providers use bearer authentication and OpenAI Chat Completions text and function tool messages. They participate in `/v1/chat`, `/v1/agent-step`, and `/v1/chat/completions`. They do not automatically support other vendors native protocols. See [client verification](TESTING-CLIENTS.md) for live JSON, SSE, tool, and key revocation checks.
