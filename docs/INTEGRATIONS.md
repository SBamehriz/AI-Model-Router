# Connect OpenClaw and other apps

## First time setup

1. Start AI Model Router with `npm run dev` and open http://localhost:3001.
2. In a second terminal, from the project root, run `npm run admin:key`.
3. Open **Settings**, paste that administrator key, and unlock.
4. Add your provider keys. OpenRouter offers several model families through
   one key. OpenAI, Anthropic, Gemini, and Groq are also supported directly.
   Use **Add custom provider** for another OpenAI compatible API, with its
   base URL, key, model ID, pricing, and capabilities.
5. Name an app connection, for example "OpenClaw laptop", choose **Create
   router key**, and copy it. You can revoke it later without changing your
   provider keys.

Provider keys stay on the router. The app gets only a router key, the base URL,
and a routing model alias. Never configure an app with the administrator key.

| Client setting | Local development value |
| --- | --- |
| API and provider type | OpenAI Chat Completions |
| Base URL | `http://localhost:3000/v1` |
| API key | The router key created in Settings |
| Model | `auto` for balance, `auto-cheap` for cost, or `auto-best` for quality |

## OpenClaw

Add this configuration to your OpenClaw gateway `~/.openclaw/openclaw.json`.
Merge it with your existing configuration rather than replacing the file.
Settings generates the same example using your connected router address.

```json
{
  "agents": {
    "defaults": { "model": { "primary": "ai-model-router/auto" } }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "ai-model-router": {
        "baseUrl": "http://localhost:3000/v1",
        "apiKey": "${AI_MODEL_ROUTER_KEY}",
        "api": "openai-completions",
        "models": [{
          "id": "auto",
          "name": "AI Model Router",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 32000,
          "maxTokens": 4096
        }]
      }
    }
  }
}
```

Set `AI_MODEL_ROUTER_KEY` in the environment of the process that runs your
OpenClaw gateway. For a manually launched gateway in PowerShell:

```powershell
$env:AI_MODEL_ROUTER_KEY = 'paste-your-router-key'
openclaw gateway
```

If the gateway runs as a service, set its service environment and secret and
restart it. Exporting a variable in a different terminal does not change a
running service environment. Do not check the key into configuration files.
The environment reference above follows OpenClaw
[custom provider configuration](https://docs.openclaw.ai/concepts/model-providers/custom-providers).

Send a short message, then check **Requests** for `/v1/chat/completions`.
For an agent check, ask OpenClaw to inspect a harmless file it is allowed to
read. Tool definitions, IDs, and results pass through the router. OpenClaw
executes its tools under its own permissions. OpenAI, Anthropic, OpenRouter, Groq, and custom models marked as tool capable
support these tool conversations. Gemini is text only in this compatibility
layer, because its tool thought signatures are not portable across providers.

`contextWindow: 32000` is a conservative client budget, not a claim that every
model has that exact limit. The router also filters candidates by estimated
context size. Raise the client budget only for a catalog you have verified.
Select `openai-completions`, not `openai-responses`. `/v1/responses` is not
implemented. See OpenClaw [provider field reference](https://docs.openclaw.ai/gateway/config-tools/custom-providers).

To use another alias in OpenClaw, update both the primary model reference and the matching model ID in the provider model list. Keep any model policy consistent with that reference.

## Your Node.js app

Set `AI_MODEL_ROUTER_KEY` in your app environment. No SDK is required.

```js
const response = await fetch('http://localhost:3000/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.AI_MODEL_ROUTER_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'auto',
    messages: [{ role: 'user', content: 'Explain binary search.' }],
  }),
});
if (!response.ok) throw new Error(await response.text());
const completion = await response.json();
console.log(completion.choices[0].message.content);
```

Clients that support a custom OpenAI base URL can use these same values.
Authentication accepts `Authorization: Bearer ...` or `X-API-Key`. Model discovery
returns the routing aliases from `GET /v1/models`.

## Local router, remote app

Online model providers work with a local router as long as your computer has
internet access. The separate issue is where your **client process** runs.

- Same computer: use `http://localhost:3000/v1` and keep the router running.
- Remote server: its `localhost` is that server. Deploy the router there, use
  the router HTTPS host, or connect the machines with a private tunnel.
- Managed app with no custom base URL: changing its API key alone is not enough.
  The app must support a custom OpenAI compatible endpoint.

For an OpenClaw gateway on a server you can SSH into, this reverse tunnel lets
it reach the router on your computer without publishing a public port.

```sh
ssh -N -R 127.0.0.1:3300:127.0.0.1:3000 user@your-server
```

Run this on the router computer. Set the remote OpenClaw provider base URL to
`http://127.0.0.1:3300/v1` and use a router key. Keep both the router and SSH
session running. The remote port binds only to loopback. SSH forwarding must
be enabled by that server. For a public HTTPS service, see [Deployment](DEPLOYMENT.md).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Cannot reach localhost | The router and client must share a computer or a tunnel. Use the remote router URL otherwise |
| 401 from router | Use a router key created on this instance. Check whether it was revoked |
| Settings stays locked | Use `npm run admin:key` or the host administrator secret, not a provider or router key |
| No capable tool model | Add OpenAI, Anthropic, OpenRouter, or Groq. Confirm a tool capable model fits the context |
| Providers all fail | Check provider balance, key validity, model access, and network. Provider errors are intentionally redacted |
| Offline replies despite a saved key | Remove `AI_MODEL_ROUTER_OFFLINE=1` and restart |
| Stream pauses before its answer | SSE is buffered. Keepalives are sent while the upstream completes, then content and tool deltas and `[DONE]` |

Compatibility tests exercise real adapters against stubbed upstream HTTP
responses, including multi turn tools and SSE. They do not certify a particular
OpenClaw installation, provider account, or every OpenAI API feature.

## Verify the generated router key

See [Testing clients](TESTING-CLIENTS.md) for `npm run test:client`, the optional function tool round trip, and the expected 401 after revocation. These live checks use the same public endpoint as OpenClaw.
