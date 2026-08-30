import { bootstrapWorker } from "@myev/worker-core";
import { AppModule } from "./app.module";

/**
 * The general worker — SYSTEM / AI work, the scheduler tick, the outbox
 * relay. No HTTP surface. All bootstrap / signal-handling / bounded-
 * shutdown / readiness-race machinery lives in `@myev/worker-core`'s
 * `bootstrapWorker` (shared verbatim with `apps/render-worker`).
 */
bootstrapWorker(AppModule, "myev-worker").catch((error: unknown) => {
  console.error("worker failed to start:", error);
  process.exitCode = 1;
});
