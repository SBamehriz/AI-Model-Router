# Security

AI Model Router defaults to localhost and is intended for a single operator.
Settings always requires an administrator key, even in the local demo.
Run `npm run admin:key` on the server to retrieve it, or configure
`AI_MODEL_ROUTER_ADMIN_KEY` through your host secret store. Do not give this
key to apps. Create revocable router keys in Settings instead. Those can call
completion endpoints and list models, but cannot administer the router or read
its usage history. Revoking the final router key does not reopen access.

The local API is open only while no provider or router keys are configured.
Health and readiness and the public dashboard shell contain no secrets. Use HTTPS
for a remote router. The dashboard refuses to send credentials over remote
HTTP. Configure `CORS_ORIGIN` if the dashboard has a separate origin.

Provider credentials can be saved through Settings or the API environment.
Saved credentials use AES 256 GCM with a random nonce and provider bound
authenticated data. The 32 byte encryption key is stored outside SQLite in
`credentials.key`, or supplied as `AI_MODEL_ROUTER_ENCRYPTION_KEY`. Keep the
data directory private with operating system permissions, including Windows
ACLs. File encryption does not protect against an attacker who can read both
the database and encryption key or control the running process. Router keys use
256 bits of randomness and only their SHA 256 hashes are stored. Settings
requests and rejected keys are limited to 60 per minute per client address,
separately from the shared request limit, so guessing runs out of attempts
without slowing a client that holds a working key. That address is the one the
socket reports. `X-Forwarded-For` is deliberately not trusted, because a header
anyone can set would let a guesser mint a fresh budget per request. Behind a
reverse proxy, which is the documented way to reach this server remotely, every
client arrives as the proxy and those two budgets become one. That costs
nothing worth having: both budgets only ever throttle traffic that is already
failing, a request carrying a working key never enters either of them, and a
rejected key returns before it can touch the shared request limit at all. One
shared guessing budget is a smaller total allowance than one per address, not a
larger one.

A custom provider endpoint is a destination the administrator chooses. It must
be HTTPS, or HTTP on loopback, without credentials, a query, or a fragment, and
redirects from it are refused. It is not restricted to public addresses, so
treat adding one as trusted configuration rather than untrusted input.

Never put provider keys in Vite variables or client bundles. The dashboard
stores the administrator key in session storage, where same origin scripts
can access it. Keep that origin trusted. Provider input fields are cleared
after saving and their values are never returned by settings endpoints.
New router keys are shown once and excluded from later responses. Credential
responses are marked `Cache-Control: no-store`. Requests send prompts and tool
definitions and results to the selected provider in live mode.
For a disconnected run, set both `AI_MODEL_ROUTER_OFFLINE=1` and
`AI_MODEL_ROUTER_DISABLE_CATALOG_FETCH=1`.

SQLite files contain request metadata, routing decisions, and usage history.
Protect them with operating system file permissions. Stop the API before
copying the database for a simple backup so pending WAL writes are checkpointed.
Back up `credentials.key` too, or retain the external encryption secret. A lost
or changed encryption key makes saved provider credentials unreadable.
Prompt and completion bodies are not persisted in the request log. Error
messages and diagnostics should still be reviewed before sharing.

The router never executes client tools. Function calls are translated for
compatible providers and returned to the calling agent. The agent remains
responsible for tool permissions and approving sensitive actions.

## Reporting a vulnerability

Use the GitHub private vulnerability reporting option if it is enabled for
this repository, or contact the maintainer through the contact information on
[their GitHub profile](https://github.com/SBamehriz). Do not post credentials or
exploit details in a public issue. Include a minimal reproduction and the
affected commit or version.

Run `npm audit` to inspect currently reported dependency advisories. Passing
tests and a clean dependency audit do not guarantee the absence of all security
issues. Supported fixes target the current branch. There is no formal security
response SLA.
