# Contributing

AI Model Router is a personal, self hosted tool. Improvements should make its
routing easier to understand, its provider calls more reliable, or its local
setup simpler. The architecture and conventions are below.

## Architecture

| Location | Responsibility |
| --- | --- |
| `apps/api/src/index.ts` | Server lifecycle, authentication hooks, CORS, limits, routes |
| `apps/api/src/lib/router.ts` | Constraints, weights, scoring, model cache |
| `apps/api/src/lib/taskClassifier.ts` | Heuristics and optional classifier escalation |
| `apps/api/src/lib/complexityEstimator.ts` | Difficulty estimates |
| `apps/api/src/lib/chatExecution.ts` | Primary execution and fallback |
| `apps/api/src/lib/providers.ts` | Original completion adapters |
| `apps/api/src/lib/compatibleProviders.ts` | Text and function tool adapter translations |
| `apps/api/src/lib/providerClient.ts` | Retry, timeout, response, and redirect handling |
| `apps/api/src/lib/credentials.ts` | Encrypted provider keys and administrator helpers |
| `apps/api/src/lib/db` | Migrations and typed database queries |
| `apps/api/src/routes` | Validated HTTP handlers |
| `apps/dashboard/src/lib/api.ts` | Typed API client |
| `apps/dashboard/src/lib/integration.ts` | Shared client configuration examples |
| `apps/dashboard/src/pages` | Introduction, guide, and dashboard pages |

The original chat and agent endpoints share the chat handler. The compatibility
endpoint has its own text and tool pipeline. They share model ranking and
persistence helpers. Keep their documented differences explicit in the
[API reference](docs/API.md) and [algorithm](docs/algorithm.md).

## Local workflow

1. Use Node.js 22.13 or newer and run `npm ci`.
2. Run `npm run dev`. No provider keys are needed.
3. Make a focused change with a clear example of the behavior it improves.
4. Run `npm run check`, `npm run test:smoke`, `npm run test:simulation`, and
   `npm run test:load`.
5. Run `npm run test:browser` after a visual change. It needs Chromium, which
   `npx playwright install chromium` fetches once. Keep it and the load check
   out of `npm run check`, which should never need a browser or a built server.
6. Update the API or algorithm documentation when behavior changes.

Use the existing TypeScript and JavaScript stack and Node built in SQLite driver.
SQL belongs in `apps/api/src/lib/db`. Append migrations instead of modifying
ones that may already have run. Unit tests use isolated databases and mocked
providers. The HTTP simulation uses local fixture servers. Neither should call
external providers or depend on real credentials.

Use strict TypeScript and validated request schemas. Keep exported types aligned
with real responses. Return structured errors with request IDs, and keep raw
provider errors and credential values out of responses and logs. Register new
routes after the authentication hooks: application keys may reach only the
completion and discovery endpoints, administration and reporting need the higher
privilege, and the dashboard shell, health, and readiness endpoints carry no
secrets. Timestamps are epoch milliseconds. Application keys are stored as
hashes and provider keys through the encrypted vault.

For UI changes, check the empty, loading, and failed states, keyboard
navigation, both themes, narrow screens, reduced motion, and enlarged text. Data
pages use the abortable resource hook with stable loaders and provide loading,
empty, and unavailable states. Use real buttons, labels, keyboard focus, table
captions, and semantic headings. Use real browser screenshots for visual changes,
which belong in `docs/images`, and label synthetic data. Never commit keys,
`.env` files, local databases, generated builds, or test output.

Adding a provider that speaks OpenAI Chat Completions with bearer authentication
needs no code: custom provider setup stores a validated endpoint and model
metadata. A native format needs its own completion and compatibility adapters,
credentials wiring, schema updates, and fixture tests.

## Model updates

Edit `apps/api/config/models.yaml`. Verify the provider model ID and pricing
against official documentation. Prices are USD per 1,000 tokens in this file.
The dashboard displays them per million. Quality and latency defaults are
curated estimates, so do not describe them as measured benchmarks.

## Issues and pull requests

Report a reproducible problem, expected behavior, your Node version, and the
relevant sanitized error. Include the request ID when useful. Keep discussions
respectful and explain trade offs directly. For vulnerabilities, follow
[SECURITY.md](SECURITY.md) instead of posting exploit details publicly.

## License

Contributions are distributed under the project [current license](LICENSE).
Preserve existing copyright notices and third party license terms. See
[licensing](docs/LICENSING.md) for how this relates to third-party code.
