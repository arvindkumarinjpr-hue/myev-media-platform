export type ShutdownOutcome = "GRACEFUL" | "FORCED" | "FAILED";

/**
 * DEFECT-1F-001 — a single, reusable bounded-shutdown policy. Knows
 * nothing about Redis, ioredis, BullMQ, Worker, or Queue — each caller
 * owns its own resource topology and supplies the two callbacks. Kept
 * dependency-free deliberately, mirroring queue-name.ts's own
 * decoupling: this package must stay usable from both apps/api and
 * apps/worker without pulling in either process's Redis-client stack.
 *
 * `gracefulClose` is raced against `deadlineMs`. If it resolves first,
 * the result is GRACEFUL. If the deadline is reached first, or if
 * `gracefulClose` itself rejects before the deadline, `forceClose` is
 * invoked and the result is FORCED (or FAILED if `forceClose` itself
 * throws).
 *
 * `forceClose` is synchronous by contract (`() => void`), not `() =>
 * Promise<void>` — this is deliberate, not an oversight. A caller whose
 * force-teardown triggers async work (e.g. BullMQ's own
 * `Worker.close(true)`, which returns a Promise) must fire it without
 * awaiting it here and attach its own swallow-catch at the call site.
 * This guarantees `boundedShutdown`'s own returned promise settles
 * within `deadlineMs` (plus negligible synchronous overhead) in every
 * case, never later — it does not depend on how long the underlying
 * force-close mechanism actually takes to fully settle internally,
 * only on it having been reliably *initiated*.
 *
 * No unhandled rejection is possible from `gracefulClose`'s own
 * promise regardless of which branch wins: `.then(onFulfilled,
 * onRejected)` attaches both handlers to it immediately, at the moment
 * it is called, before the race even begins — not after the fact.
 */
export async function boundedShutdown(gracefulClose: () => Promise<void>, forceClose: () => void, deadlineMs: number): Promise<ShutdownOutcome> {
  let deadlineTimer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<"timeout">((resolve) => {
    deadlineTimer = setTimeout(() => resolve("timeout"), deadlineMs);
  });

  const graceful = gracefulClose().then(
    () => "resolved" as const,
    () => "rejected" as const,
  );

  const winner = await Promise.race([graceful, deadline]);
  clearTimeout(deadlineTimer);

  if (winner === "resolved") {
    return "GRACEFUL";
  }

  try {
    forceClose();
    return "FORCED";
  } catch {
    return "FAILED";
  }
}
