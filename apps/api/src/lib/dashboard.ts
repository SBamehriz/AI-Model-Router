import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Paths that belong to the API. They keep their JSON 404s. */
const API_PREFIXES = ['/v1/', '/admin/'];

/** Something with an extension is an asset request, not a page. */
const ASSET_PATH = /\.[a-z0-9]+$/i;

/**
 * Whether an unmatched path is a dashboard page, and so should get the shell
 * rather than a JSON 404. The path is decoded first, because /%2eenv and /.env
 * are the same request and answering them differently is a hint.
 */
export function isDashboardPagePath(rawPath: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  if (ASSET_PATH.test(path)) return false;
  // The bare prefix is the API too. /v1 with no slash is what a client sends
  // when it probes its base URL, and answering it with the interface, 200 and
  // HTML, told that client the endpoint existed.
  if (API_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))) return false;
  return !path.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * One origin for the interface and the API in production.
 *
 * Built assets are served from disk. Every other page path falls through to the
 * not found handler, which returns the shell so the client router can read the
 * URL. Listing page paths here would mean a new page renders in development and
 * 404s in production.
 */
export async function registerDashboard(
  app: FastifyInstance,
  root = fileURLToPath(new URL('../../../dashboard/dist/', import.meta.url))
): Promise<void> {
  if (!existsSync(join(root, 'index.html'))) return;
  // Dotfiles are treated as absent rather than refused, so probing for one
  // gets the same plain 404 as any other path that is not there.
  await app.register(fastifyStatic, { root, index: false, dotfiles: 'ignore' });
  // A request for the directory itself never reaches the not-found handler.
  app.get('/', (_req, reply) =>
    reply.header('Cache-Control', 'no-store').sendFile('index.html', { cacheControl: false })
  );
}
