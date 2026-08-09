import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import type { ShutdownOutcomeTracker } from "@myev/shared";
import { AppModule } from "./app.module";
import { SHUTDOWN_TRACKER } from "./shutdown/shutdown.module";

/**
 * Worker as a NestJS application context — no HTTP listener. Chosen (per
 * the frozen Module 1F Engineering Plan) to get fail-fast bootstrap
 * validation hooks (OnApplicationBootstrap), structured-logging
 * consistency with the API (shared nestjs-pino config shape), and direct
 * PrismaService reuse, all through the same DI/module system apps/api
 * already uses — without exposing any network surface.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.flushLogs();

  const shutdownTracker = app.get<ShutdownOutcomeTracker>(SHUTDOWN_TRACKER);

  // DEFECT-1F-001, Engineering Plan §5/§8. Not app.enableShutdownHooks()
  // — confirmed by reading @nestjs/core's own listenToShutdownSignals
  // implementation (nest-application-context.js): after its hooks
  // complete, it removes its own signal listener and re-delivers the
  // ORIGINAL signal to this process via process.kill(process.pid,
  // signal), relying on the OS's default disposition to terminate it.
  // A process terminated this way reports as "killed by signal" to
  // whatever spawned it (code: null, signal: <name>) — process.exitCode
  // is never consulted at all, because termination never goes through
  // Node's normal exit-with-process.exitCode path. Empirically verified
  // via a real spawned-process SIGTERM/SIGINT test before settling on
  // this design, not assumed.
  //
  // app.close() alone (confirmed identical to enableShutdownHooks()'s
  // own internal call sequence — both call callDestroyHook/
  // callBeforeShutdownHook/dispose/callShutdownHook) already fires
  // every OnModuleDestroy/OnApplicationShutdown hook. Registering our
  // own signal handlers around that same call keeps the correct,
  // orchestrator-expected Unix behavior for the common case (GRACEFUL
  // and FORCED both terminate via the signal itself, exactly as
  // enableShutdownHooks() would have done — SIGTERM is the normal
  // signal during routine deployments, and a FORCED outcome already
  // surfaces via the REDIS_SHUTDOWN_FORCED warn log, this project's
  // established channel for a Redis-availability condition, not
  // process exit codes) while adding the one thing the convenience
  // method cannot provide: a genuine FAILED outcome (the bounded-
  // shutdown fallback itself threw — a real defect, not a dependency-
  // availability condition) short-circuits with an explicit non-zero
  // exit instead.
  const shutdownSignals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  let shuttingDown = false;
  for (const signal of shutdownSignals) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async () => {
        // DEFECT-1F-001 final correction: mirrors NestJS's own
        // enableShutdownHooks() cleanup() try/catch exactly (confirmed
        // by reading nest-application-context.js) — without this, a
        // rejection from ANY lifecycle hook (not necessarily one this
        // defect touched — any OnModuleDestroy/OnApplicationShutdown in
        // the whole DI graph) would escape this void async IIFE as an
        // unhandled promise rejection, crashing the process via Node's
        // own uncaught-exception path instead of the intended,
        // deterministic FAILED policy. console.error, not the NestJS
        // logger, mirrors this same file's own bootstrap().catch()
        // fallback below — the logger provider may itself already be
        // torn down by the time a shutdown hook has failed. Never logs
        // the raw error object (could carry a connection string) — only
        // a safe .message string.
        try {
          await app.close();
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "APPLICATION_SHUTDOWN_FAILED",
              service: "myev-worker",
              signal,
              err: { message: error instanceof Error ? error.message : String(error) },
            }),
          );
          process.exit(1);
          return;
        }
        if (shutdownTracker.hasFailure()) {
          process.exit(1);
          return;
        }
        for (const sig of shutdownSignals) process.removeAllListeners(sig);
        process.kill(process.pid, signal);
      })();
    });
  }
}

bootstrap().catch((error: unknown) => {
  // Logger is scoped inside bootstrap and may not exist yet if
  // configuration itself threw — this is the last-resort fallback path.
  console.error("worker failed to start:", error);
  process.exitCode = 1;
});
