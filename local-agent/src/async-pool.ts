/**
 * The two primitives concurrency needs.
 *
 * A build step is two phases: talking to the model, which is 90 seconds and
 * touches nothing shared, and everything after the reply, which is milliseconds
 * and touches the workspace, the backup directory, the delta ledger and the
 * approval queue. Only the first runs concurrently.
 */

/** Runs bodies one at a time, in the order they queued. */
export function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      // Chain onto the tail, but swallow the previous body's rejection here so
      // one failed step cannot wedge the lock for the rest of the build.
      const result = tail.then(() => fn(), () => fn());
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

/** Hands out a fixed set of workers, making callers wait when none is free. */
export function createPool<T>(items: T[]) {
  const free: T[] = items.slice();
  const waiting: ((item: T) => void)[] = [];
  return {
    acquire(): Promise<T> {
      const ready = free.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise<T>((resolve) => waiting.push(resolve));
    },
    release(item: T): void {
      // Hand it straight to whoever is waiting rather than round-tripping
      // through the free list, so a queued caller cannot be jumped.
      const next = waiting.shift();
      if (next) next(item);
      else free.push(item);
    },
    size(): number {
      return items.length;
    },
  };
}
