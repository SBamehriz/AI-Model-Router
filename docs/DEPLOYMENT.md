# Run and deploy AI Model Router

## One production server

Use Node.js 22.13 or newer and a persistent filesystem. From the repository
root.

```sh
npm ci
npm run build
npm start
```

The API serves `apps/dashboard/dist` at http://localhost:3000. Dashboard routes
such as `/settings` work directly. API calls use the same origin by default.
No separate static web service is necessary. Rebuild after frontend changes.

For local development, `npm run dev` opens the dashboard on port 3001 and runs
the API on port 3000. Stop it with Ctrl+C before starting another copy. A port
conflict means another process is already listening. Do not kill unrelated
Node processes to fix it.

## Native Node hosting

Use one continuously running Node process on a service with a persistent disk.
Set these host environment variables.

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` when your host proxies into the process |
| `PORT` | The port assigned by the host, otherwise 3000 |
| `DATABASE_PATH` | An absolute path on its persistent disk, for example `/var/data/ai-model-router.db` |
| `AI_MODEL_ROUTER_ADMIN_KEY` | A generated random secret of at least 32 characters |

Build with `npm ci --include=dev && npm run build`, start with `npm start`, and
use `/ready` for the health check. Terminate HTTPS with your host or reverse
proxy. In Settings, use the administrator secret from your host, add provider
keys, and create router keys. Give apps `https://your-router-host/v1`.

SQLite and `credentials.key` must survive restarts and deployments. Keep one
instance. Do not place independent SQLite copies behind a load balancer.
Ephemeral serverless functions and static only hosts are not suitable for this
server. A separately hosted dashboard may set `VITE_API_URL` at build time and
requires its exact origin in the API `CORS_ORIGIN` allowlist. Never put keys
in Vite environment variables.

## Render template

The root [render.yaml](../render.yaml) configures a native Node web service with
a persistent disk and generated administrator secret. Connect this repository
as a Blueprint in Render, review the service and disk charges, and apply it.
The included compute plan and persistent disk are paid resources. No deploy
has been performed on your behalf.

After deployment, reveal `AI_MODEL_ROUTER_ADMIN_KEY` in the service environment
settings and use it to unlock the dashboard at its HTTPS URL. Add provider keys
there. The encrypted provider records and local encryption key persist under
`/var/data`. Render documents its [Blueprint fields](https://render.com/docs/blueprint-spec)
and [persistent disk behavior](https://render.com/docs/disks).

## Backups and recovery

For a simple consistent backup, stop the Node process cleanly, then copy the
SQLite file and its sibling `credentials.key` into protected backup storage.
If WAL and SHM files remain after an interrupted shutdown, preserve the entire data
directory rather than copying only the main database while it is active.
Restore the same encryption key with the database before starting the server.
If `AI_MODEL_ROUTER_ENCRYPTION_KEY` is set, retain that external secret instead
of relying on a local key file. It must be exactly 32 random bytes encoded as
base64. Changing it without re encrypting credentials makes them unreadable.

`npm run admin:key` retrieves the current administrator key on the server.
To rotate administrator access independently, set a new
`AI_MODEL_ROUTER_ADMIN_KEY` and restart. Update dashboard sessions. Integration
keys remain independent. Revoke and replace them through Settings.

Use operating system permissions to protect the data directory and backup.
Encryption at rest does not protect secrets from someone who controls the
server process or can read both the database and its encryption key.
