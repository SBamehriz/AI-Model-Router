# Test the router with a real client

Open **User guide** and choose **Test a connection** for these steps inside the running application. Search by command, provider, or error code to find related help.

## Simulate without provider accounts

```sh
npm run build
npm run test:simulation
```

This starts isolated router and provider servers on local ports. It tests model discovery, generated keys, JSON, SSE, function tools, fallback, retries, invalid input, encrypted persistence, and revocation across restarts. It removes its temporary database afterward. No external provider or installed OpenClaw gateway is called.

## Verify your own account

The router serves an OpenAI compatible API. A generated **router key** grants an app access to it. Provider keys belong in Settings. The administrator key unlocks Settings and should not be used by your app.

1. Start the router with `npm run dev`, unlock Settings, and save a provider key. For a custom provider, also enter its API base URL, model ID, current prices, context window, and tool capability. Custom APIs must implement OpenAI Chat Completions with bearer authentication. Native formats other than the built in adapters need their own adapter.
2. Create a router key under **Connect your apps** and copy it once.
3. Open PowerShell in this repository. Use the API base URL shown in Settings, including `/v1`. Enter the key at the hidden prompt below, so it is not stored in command history.

```powershell
$env:AI_MODEL_ROUTER_BASE_URL = 'http://localhost:3000/v1'
$routerTestSecret = Read-Host 'Router key' -AsSecureString
$env:AI_MODEL_ROUTER_KEY = [System.Net.NetworkCredential]::new('', $routerTestSecret).Password
npm run test:client
# Also check function calling before connecting an agent.
npm run test:client -- --tools
# Clear the key from this terminal when finished.
Remove-Item Env:AI_MODEL_ROUTER_KEY
```

The basic test checks model discovery with your router key, a JSON completion, and an SSE completion with usage and `[DONE]`. It makes **two live provider requests**. `--tools` adds **two more** to test a harmless echo function and its result. Provider charges apply. It reports the selected model and request IDs, without printing your key. Run this from the machine or container hosting your client to also check network reachability.

The default test refuses simulated replies. `npm run test:client -- --allow-offline` checks the local protocol without verifying provider access. The repository `npm run check` and `npm run test:smoke` use isolated data and mocked and simulated providers. They do not prove your provider key or account works.

## OpenClaw

In Settings, expand **OpenClaw configuration**, copy it into `~/.openclaw/openclaw.json`, and set `AI_MODEL_ROUTER_KEY` in the gateway environment. Use the following connection settings.

- Provider API: `openai-completions`
- Base URL: your reachable router address ending in `/v1`
- Model reference: `ai-model-router/auto`

This follows [OpenClaw custom provider configuration](https://docs.openclaw.ai/gateway/config-tools/custom-providers). Keep any model allowlist in your existing configuration consistent with the chosen reference. Restart the gateway, send a short message, then try a harmless tool task. In **Requests**, confirm the `/v1/chat/completions` entry is successful and marked **Live**, and inspect the selected provider and model. A script passing is useful evidence. A message and tool round trip from your installed OpenClaw version completes the integration check.

The adapter supports text and function tools. Gemini is text only in this router. SSE is buffered. The answer arrives after the provider completes, not token by token. Images, audio, the OpenAI Responses API, and provider specific reasoning extensions are not implemented. Configure context and output limits to fit your actual model pool. The copied configuration limits are starting values, not a guarantee for every model.

Changing the alias means changing it in two places in your configuration. The [integration guide](INTEGRATIONS.md) says which, and is the one copy of that instruction.

## Troubleshooting

| Result | What to check |
| --- | --- |
| Connection refused and timeout | Router process, API port, reachable hostname, firewall. A remote gateway localhost is not your laptop. Use HTTPS for remote connections. |
| 401 | Missing, incorrect, or revoked router key. A provider key is not a router key. |
| 403 | Router keys cannot read dashboard administration endpoints. The test uses permitted endpoints. |
| 422 and no capable model | Model capability, task strengths, quality estimate, context limit, and function tool checkbox. |
| 502 and provider error | Provider base URL, exact model ID, key permissions, account credit, or upstream availability. |
| Offline mode | Save a provider key and remove `AI_MODEL_ROUTER_OFFLINE=1`, then restart if you changed the environment. |
| Browser cannot save or revoke | Restart the API after updating. The CORS fix allows PUT and DELETE. Include the dashboard origin in `CORS_ORIGIN`. |

To verify revocation, create a disposable router key, confirm the client test passes, revoke that key in Settings, then rerun the test with the same key. Model discovery must return **401**. Revocation stops new requests. It does not cancel a request already in progress.

## Custom provider examples

Use the provider current documentation for model IDs, prices, and context windows.

- DeepSeek: `https://api.deepseek.com`, [API documentation](https://api-docs.deepseek.com/).
- Moonshot: `https://api.moonshot.ai/v1`, [OpenClaw Moonshot example](https://docs.openclaw.ai/concepts/model-providers/custom-providers).

The router appends `/chat/completions`. Add multiple models with **Add model**, or use **Edit model and key** to update an existing model or rotate its key. Custom model pricing and routing estimates are supplied by you and survive catalog refreshes. If you change the endpoint, enter its key again to confirm which credential belongs to that destination.
