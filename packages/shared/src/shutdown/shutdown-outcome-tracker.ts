import type { ShutdownOutcome } from "./bounded-shutdown";

/**
 * DEFECT-1F-001, Engineering Plan §5/§8 — packages/shared's
 * boundedShutdown never touches process.exitCode itself; that decision
 * belongs to application-level code (main.ts), not this package. This
 * tracker is the plain, framework-agnostic record each
 * shutdown-participating component reports its own outcome into, so
 * main.ts can read it — after every component's onApplicationShutdown/
 * onModuleDestroy has run — and decide the process's exit code.
 *
 * Deliberately not itself a NestJS provider (no @Injectable) — each
 * app wires ONE instance of this plain class into its own DI graph via
 * a thin app-local module (apps/worker/src/shutdown/shutdown.module.ts,
 * apps/api's equivalent), consistent with how EventPublisher is
 * likewise a plain class provided via useValue rather than a
 * framework-coupled one.
 */
export class ShutdownOutcomeTracker {
  private readonly outcomes = new Map<string, ShutdownOutcome>();

  record(component: string, outcome: ShutdownOutcome): void {
    this.outcomes.set(component, outcome);
  }

  hasFailure(): boolean {
    return [...this.outcomes.values()].some((outcome) => outcome === "FAILED");
  }

  getAll(): ReadonlyMap<string, ShutdownOutcome> {
    return new Map(this.outcomes);
  }
}
