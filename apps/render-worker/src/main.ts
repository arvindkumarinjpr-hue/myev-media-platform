import { bootstrapWorker } from "@myev/worker-core";
import { AppModule } from "./app.module";

/**
 * The dedicated render / media worker — the MEDIA queue only. No HTTP
 * surface. All bootstrap / signal-handling / bounded-shutdown /
 * readiness-race machinery lives in `@myev/worker-core`'s
 * `bootstrapWorker` (shared verbatim with `apps/worker`).
 */
bootstrapWorker(AppModule, "myev-render-worker").catch((error: unknown) => {
  console.error("render-worker failed to start:", error);
  process.exitCode = 1;
});
