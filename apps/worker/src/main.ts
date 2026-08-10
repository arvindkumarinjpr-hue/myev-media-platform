import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplicationContext } from "@nestjs/common";
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
  const shutdownSignals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  let shuttingDown = false;
  // Must stay `let`, pre-declared as undefined, NOT folded into a single
  // `const app = await NestFactory...` at its assignment point below.
  // The signal handlers registered immediately after this block close
  // over `app`/`shutdownTracker` before either is ever assigned; if
  // these were `const`, a signal arriving before that later line
  // executes would hit the temporal dead zone and throw a
  // ReferenceError instead of safely deferring via earlySignal. ESLint's
  // prefer-const only sees a single assignment and cannot see this
  // constraint, hence the disables below.
  // eslint-disable-next-line prefer-const
  let app: INestApplicationContext | undefined;
  // eslint-disable-next-line prefer-const
  let shutdownTracker: ShutdownOutcomeTracker | undefined;
  let earlySignal: NodeJS.Signals | undefined;

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
  async function runShutdown(nestApp: INestApplicationContext, tracker: ShutdownOutcomeTracker, signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    // DEFECT-1F-001 final correction: mirrors NestJS's own
    // enableShutdownHooks() cleanup() try/catch exactly (confirmed
    // by reading nest-application-context.js) — without this, a
    // rejection from ANY lifecycle hook (not necessarily one this
    // defect touched — any OnModuleDestroy/OnApplicationShutdown in
    // the whole DI graph) would escape as an unhandled promise
    // rejection, crashing the process via Node's own uncaught-
    // exception path instead of the intended, deterministic FAILED
    // policy. console.error, not the NestJS logger, mirrors this same
    // file's own bootstrap().catch() fallback below — the logger
    // provider may itself already be torn down by the time a shutdown
    // hook has failed. Never logs the raw error object (could carry a
    // connection string) — only a safe .message string.
    try {
      await nestApp.close();
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
    if (tracker.hasFailure()) {
      process.exit(1);
      return;
    }
    for (const sig of shutdownSignals) process.removeAllListeners(sig);
    process.kill(process.pid, signal);
  }

  // DEFECT-1F-001 SIGNAL-HANDLER READINESS RACE FIX. Registered as the
  // very first thing in bootstrap() — before NestFactory.
  // createApplicationContext() even starts, not after it resolves (the
  // previous ordering). The previous ordering left a real window: every
  // module's OnApplicationBootstrap hook must complete before
  // createApplicationContext()'s own promise resolves, but they do not
  // all complete at the same moment — WorkerHeartbeatService's hook (an
  // unconditional, synchronous-relative-to-Postgres write) can finish,
  // making its worker_heartbeats row externally visible, while a LATER
  // module's own bootstrap hook (e.g. OutboxRelayManager's bounded Redis
  // scheduler registration, up to schedulerRegistrationTimeoutMs) is
  // still in flight. A real SIGTERM/SIGINT arriving in that window
  // previously fell through to the OS's default signal disposition —
  // silently skipping app.close() entirely — because no listener existed
  // yet. Registering here first means a listener always exists from the
  // earliest possible instant; if Nest hasn't finished resolving yet
  // when a signal arrives, it is deferred (never lost, never silently
  // ignored) and actioned the instant bootstrap completes, using the
  // app/tracker that just became available.
  for (const signal of shutdownSignals) {
    process.on(signal, () => {
      if (shuttingDown) return;
      if (!app || !shutdownTracker) {
        earlySignal = signal;
        return;
      }
      void runShutdown(app, shutdownTracker, signal);
    });
  }

  const resolvedApp = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  resolvedApp.useLogger(resolvedApp.get(Logger));
  resolvedApp.flushLogs();
  app = resolvedApp;
  shutdownTracker = resolvedApp.get<ShutdownOutcomeTracker>(SHUTDOWN_TRACKER);

  // READINESS INVARIANT (DEFECT-1F-001 signal-handler readiness race
  // fix). By this line, SIGTERM/SIGINT listeners have been armed (above,
  // before Nest's own bootstrap even began) AND the application context
  // has fully resolved — every OnApplicationBootstrap hook, across every
  // module, has already run. This is therefore the first point at which
  // this process may safely be considered "ready" by anything watching
  // from outside; external readiness checks must wait for this line,
  // never for an earlier bootstrap-phase side effect like the heartbeat
  // row alone. Printed via raw console.log, not the pino logger, so it
  // is never silently dropped by LOG_LEVEL filtering (the same class of
  // gap already root-caused once for a different log line — see
  // .github/workflows/ci.yml's "Start Worker (background)" step
  // comment).
  console.log(JSON.stringify({ event: "APPLICATION_READY", service: "myev-worker" }));

  if (earlySignal && app && shutdownTracker) {
    void runShutdown(app, shutdownTracker, earlySignal);
  }
}

bootstrap().catch((error: unknown) => {
  // Logger is scoped inside bootstrap and may not exist yet if
  // configuration itself threw — this is the last-resort fallback path.
  console.error("worker failed to start:", error);
  process.exitCode = 1;
});
