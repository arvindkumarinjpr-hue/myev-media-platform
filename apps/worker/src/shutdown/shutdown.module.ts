import { Global, Module } from "@nestjs/common";
import { ShutdownOutcomeTracker } from "@myev/shared";

export const SHUTDOWN_TRACKER = Symbol("SHUTDOWN_TRACKER");

/**
 * DEFECT-1F-001 — one process-lifetime ShutdownOutcomeTracker instance,
 * injected into every Redis-connected component that performs a
 * boundedShutdown (BullMqWorkerManager, SchedulerTickManager). main.ts
 * reads it, via the same DI container, after app.close() resolves, to
 * decide process.exitCode — see this module's own doc comment in
 * @myev/shared for why that decision does not live in the shared
 * package itself.
 */
@Global()
@Module({
  providers: [{ provide: SHUTDOWN_TRACKER, useValue: new ShutdownOutcomeTracker() }],
  exports: [SHUTDOWN_TRACKER],
})
export class ShutdownModule {}
