import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerDashboard } from '../dashboard.js';
import { registerErrors } from '../errors.js';

describe('production dashboard hosting', () => {
  let app: FastifyInstance;
  let directory: string;
  afterEach(async () => { await app?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });

  it('serves SPA routes and static assets while keeping API misses and secrets inaccessible', async () => {
    directory = mkdtempSync(join(tmpdir(), 'ai-model-router-site-'));
    writeFileSync(join(directory, 'index.html'), '<!doctype html><title>AI Model Router</title>');
    writeFileSync(join(directory, 'router-mark.svg'), '<svg></svg>');
    writeFileSync(join(directory, '.env'), 'SECRET');
    app = Fastify();
    registerErrors(app);
    await registerDashboard(app, directory);
    // Every page the client router owns reaches the browser as the shell,
    // including one added after this file was written.
    for (const route of ['/', '/settings', '/playground', '/about', '/a-page-added-later']) {
      const page = await app.inject(route);
      expect(page.statusCode, route).toBe(200);
      expect(page.headers['cache-control']).toContain('no-store');
      expect(page.body).toContain('<title>AI Model Router</title>');
    }
    expect((await app.inject('/router-mark.svg')).statusCode).toBe(200);
    // An API miss, a missing asset and a dotfile all answer the same way,
    // however the dotfile is spelled. None of them may return the shell.
    // The bare prefixes are API too: /v1 is what a client sends to probe its
    // base URL, and it used to get the shell with a 200.
    for (const route of ['/v1', '/admin', '/v1/missing', '/admin/missing', '/assets/missing.js', '/.env', '/%2eenv', '/../.env']) {
      const response = await app.inject(route);
      expect(response.statusCode, route).toBe(404);
      expect(response.json(), route).toMatchObject({ error: { code: 'not_found' } });
      expect(response.body, route).not.toContain('SECRET');
      expect(response.body, route).not.toContain('<!doctype');
    }
  });

  it('leaves API-only startup usable before the dashboard is built', async () => {
    directory = mkdtempSync(join(tmpdir(), 'ai-model-router-site-'));
    app = Fastify();
    registerErrors(app);
    await registerDashboard(app, directory);
    const missing = await app.inject('/');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
