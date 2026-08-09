import { Global, Module } from "@nestjs/common";
import { ShutdownOutcomeTracker } from "@myev/shared";

export const SHUTDOWN_TRACKER = Symbol("SHUTDOWN_TRACKER");

/**
 * DEFECT-1F-001 — API-process twin of apps/worker's identical module.
 * One process-lifetime ShutdownOutcomeTracker instance, injected into
 * BackgroundJobsService (the one Redis-connected component in this
 * process that performs a boundedShutdown). main.ts reads it after
 * app.close() resolves to decide process.exitCode.
 */
@Global()
@Module({
  providers: [{ provide: SHUTDOWN_TRACKER, useValue: new ShutdownOutcomeTracker() }],
  exports: [SHUTDOWN_TRACKER],
})
export class ShutdownModule {}
