import { Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { ShutdownOutcomeTracker } from "@myev/shared";
import { SHUTDOWN_TRACKER } from "../shutdown/shutdown.module";

/**
 * DEFECT-1F-001 FINAL SIGNAL ERROR-HANDLING FIX — test fixture only.
 * API-process twin of apps/worker's identical module — see that file's
 * doc comment for the full rationale (SIMULATE_SHUTDOWN_FAILURE=true
 * throws; SIMULATE_TRACKER_FAILURE=true records FAILED without
 * throwing). Never imported unless one of those env vars is explicitly
 * set.
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
