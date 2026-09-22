import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import { validateEnv } from './lib/env.js';
import { registerErrors } from './lib/errors.js';
import { closeDb, getDb } from './lib/db/index.js';
import { ensureCatalog, catalogStatus, startCatalogRefresh } from './lib/modelCatalog.js';
import { registerAuth, authRequired } from './lib/auth.js';
import { setRetryLogger } from './lib/providerClient.js';
import { configuredProviders, isOfflineMode } from './lib/providerAvailability.js';
import { chatRoutes } from './routes/chat.js';
import { usageRoutes } from './routes/usage.js';
import { modelsRoutes } from './routes/models.js';
import { requestsRoutes } from './routes/requests.js';
import { providersRoutes } from './routes/providers.js';
import { debugRoutes } from './routes/debug.js';
import { settingsRoutes } from './routes/settings.js';
import { completionsRoutes } from './routes/completions.js';
import { healthRoutes } from './routes/health.js';
import { registerDashboard } from './lib/dashboard.js';
import { initializeCredentials, providerCredential, providerCredentialStatus } from './lib/credentials.js';

const env = validateEnv();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers["x-api-key"]'] },
  bodyLimit: 2 * 1024 * 1024,
  genReqId: () => crypto.randomUUID(),
  // The built in pair of lines per request is replaced by the two hooks below,
  // which carry the same id a caller was given. Said through a log controller
  // rather than the top level switch of the same name, which is deprecated and
  // goes in Fastify 6. The controller takes an instance, not a class, and
  // overriding nothing else leaves every other logging decision at its default.
  logController: new LogController({ disableRequestLogging: true }),
});

await app.register(helmet, { contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  // Charts set inline styles on the elements they draw.
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'],
  // Settings can point the dashboard at another instance, which is why a
  // remote HTTPS origin is allowed alongside this one and a local router.
  connectSrc: ["'self'", 'https:', 'http://localhost:*', 'http://127.0.0.1:*'],
  // Nothing here is meant to be embedded, so no page may frame it.
  frameAncestors: ["'none'"],
  upgradeInsecureRequests: null,
} } });
await app.register(compress, { global: true, threshold: 1024, encodings: ['gzip', 'deflate', 'br'] });
await app.register(cors, {
  origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

app.addHook('onRequest', async (req) => {
  app.log.info(
    { request_id: String(req.id), method: req.raw?.method, url: req.raw?.url, remote: req.ip },
    'request received'
  );
});

app.addHook('onResponse', async (req, reply) => {
  app.log.info(
    {
      request_id: req.request_id ?? String(req.id),
      method: req.raw?.method,
      url: req.raw?.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime != null ? Math.round(Number(reply.elapsedTime)) : undefined,
    },
    'request completed'
  );
});

// Retries are worth seeing, in the structured log rather than on stderr.
setRetryLogger((info) => app.log.warn(info, 'provider call failed, retrying'));

registerErrors(app);

registerAuth(app);
await app.register(healthRoutes);
await app.register(chatRoutes, { prefix: '/v1' });
await app.register(usageRoutes, { prefix: '/v1' });
await app.register(modelsRoutes, { prefix: '/v1' });
await app.register(requestsRoutes, { prefix: '/v1' });
await app.register(providersRoutes, { prefix: '/v1' });
await app.register(debugRoutes, { prefix: '/v1/router' });
await app.register(settingsRoutes, { prefix: '/admin' });
await app.register(completionsRoutes, { prefix: '/v1' });
await registerDashboard(app);

// Open the database, creating and migrating it if needed, then make sure the
// catalog is populated before serving traffic.
getDb();
initializeCredentials();
// Fail startup if a restored database cannot be decrypted with this host's key.
for (const provider of providerCredentialStatus()) if (provider.configured) providerCredential(provider.provider);
await ensureCatalog(app.log);
const stopCatalogRefresh = startCatalogRefresh(app.log);

await app.listen({ port: env.PORT, host: env.HOST });

const status = catalogStatus();
app.log.info(
  {
    // Resolved, because DATABASE_PATH is relative to the working directory.
    // Started from the wrong one, the server quietly creates an empty database
    // and the dashboard looks like it lost its history. The absolute path is
    // the fastest way to see that is what happened.
    database: resolve(process.cwd(), env.DATABASE_PATH),
    models: status.models,
    catalog_source: status.source,
    providers: configuredProviders(),
  },
  'AI Model Router ready'
);
if (isOfflineMode()) {
  app.log.warn(
    'Offline mode. Completions are simulated. ' +
      'For live completions, add a provider key in Settings and remove any AI_MODEL_ROUTER_OFFLINE=1 override.'
  );
}

// Keys are read from the working directory, which is this workspace. A file
// left in the repository root is silently ignored, which looks like a key that
// does not work, so name it rather than starting offline without explanation.
const localEnv = resolve(process.cwd(), '.env');
const rootEnv = resolve(process.cwd(), '../../.env');
if (!existsSync(localEnv) && existsSync(rootEnv)) {
  app.log.warn(`${rootEnv} is not read. Move it to ${localEnv}, or set the keys in Settings.`);
} else if (existsSync(localEnv) && existsSync(rootEnv)) {
  // Two files, and which one is read depends on the directory the process was
  // started from rather than on anything visible in either file. That is worse
  // than the missing case: the keys appear to work, a second copy of them sits
  // on disk, and editing the wrong one changes nothing.
  app.log.warn(`${rootEnv} is a second copy of ${localEnv} and is not read from here. Keep one.`);
}
app.log.info('To unlock Settings, run npm run admin:key in another terminal.');
if (!authRequired()) {
  app.log.warn(
    `No provider or router key is configured, so /v1 is open. Fine on ${env.HOST}. ` +
      'Create a router key in Settings before exposing this server.'
  );
}

// A second signal, or a request that never finishes, should not leave the
// process hanging until the supervisor kills it.
const SHUTDOWN_DEADLINE_MS = 10_000;
let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received, shutting down`);
  const deadline = setTimeout(() => {
    app.log.error({ after_ms: SHUTDOWN_DEADLINE_MS }, 'shutdown took too long, exiting now');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref();
  try {
    stopCatalogRefresh();
    await app.close();
    closeDb();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => app.log.error({ reason }, 'unhandled rejection'));
process.on('uncaughtException', (error) => {
  app.log.error({ err: error }, 'uncaught exception');
  void shutdown('UNCAUGHT_EXCEPTION');
});
