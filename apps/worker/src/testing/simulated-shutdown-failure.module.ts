import { Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { ShutdownOutcomeTracker } from "@myev/shared";
import { SHUTDOWN_TRACKER } from "../shutdown/shutdown.module";

/**
 * DEFECT-1F-001 FINAL SIGNAL ERROR-HANDLING FIX — test fixture only.
 * Exists solely so the real-spawned-process regression tests can prove
 * two distinct failure paths against an actual OS process (a
 * requirement that cannot be satisfied by mocking, since the assertion
 * is about real process-exit semantics):
 *
 *  - SIMULATE_SHUTDOWN_FAILURE=true: this provider's own
 *    onApplicationShutdown THROWS — exercises main.ts's new try/catch
 *    around app.close() itself.
 *  - SIMULATE_TRACKER_FAILURE=true: this provider records a FAILED
 *    outcome directly into the shared ShutdownOutcomeTracker and
 *    resolves normally (does NOT throw) — exercises the pre-existing,
 *    separate `if (shutdownTracker.hasFailure())` branch, proving it
 *    still triggers exit 1 even when app.close() itself resolves
 *    cleanly.
 *
 * Never imported unless one of those env vars is explicitly set —
 * inert in every real deployment. Does not touch boundedShutdown,
 * BullMqWorkerManager, SchedulerTickManager, or BackgroundJobsService.
 */
@Injectable()
export class SimulatedShutdownFailureProvider implements OnApplicationShutdown {
  constructor(@Inject(SHUTDOWN_TRACKER) private readonly shutdownTracker: ShutdownOutcomeTracker) {}

  onApplicationShutdown(): void {
    if (process.env.SIMULATE_TRACKER_FAILURE === "true") {
      this.shutdownTracker.record(SimulatedShutdownFailureProvider.name, "FAILED");
      return;
    }
    throw new Error("simulated shutdown failure (SIMULATE_SHUTDOWN_FAILURE test fixture)");
  }
}

@Module({ providers: [SimulatedShutdownFailureProvider] })
export class SimulatedShutdownFailureModule {}
