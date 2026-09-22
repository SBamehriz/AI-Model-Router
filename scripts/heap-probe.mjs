/**
 * Preloaded into the server the load harness starts, with --import, so that
 * the server's own heap can be read from inside it.
 *
 * Resident size cannot answer whether anything is being retained: the
 * allocator keeps pages it has already freed, so it rises under load and stays
 * risen whether or not a single object survived. The number that answers the
 * question is the heap after a collection, and only the process itself can
 * force one. This answers a request for that over the IPC channel the harness
 * opens, and touches nothing else in the process.
 *
 * Nothing in apps/ imports this. It exists only for scripts/load.mjs, and the
 * server it runs against is the built one, unmodified.
 */
if (typeof process.send === 'function') {
  process.on('message', (message) => {
    if (message !== 'heap-sample') return;
    if (typeof globalThis.gc !== 'function') {
      // Sampling without --expose-gc would report whatever the allocator
      // happened to be holding, which is the reading that cannot distinguish
      // a leak from a busy allocator. Say so rather than answer.
      process.send({ error: 'gc-not-exposed' });
      return;
    }
    // Twice: the first pass can resurrect objects through finalizers, and what
    // survives the second is what is actually retained.
    globalThis.gc();
    globalThis.gc();
    const usage = process.memoryUsage();
    process.send({
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      rss: usage.rss,
      external: usage.external,
    });
  });
}
