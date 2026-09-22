/**
 * Silence the one warning node:sqlite prints when it loads. The module is still
 * flagged experimental on Node 22, so the warning would appear on every start,
 * every test run and every script, where it reads as a fault rather than a
 * status.
 *
 * Only that warning is dropped. Everything else still reaches stderr, the
 * supported Node range is pinned in package.json, and the test suite is what
 * guards against the API changing.
 *
 * This must be imported before node:sqlite, because the warning is emitted
 * while that module is evaluated.
 */
const emitWarning = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  const message = typeof warning === 'string' ? warning : (warning?.message ?? '');
  if (type === 'ExperimentalWarning' && message.includes('SQLite')) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};
