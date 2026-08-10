import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Logger } from "nestjs-pino";
import cookieParser from "cookie-parser";
import type { ShutdownOutcomeTracker } from "@myev/shared";
import { AppModule } from "./app.module";
import type { AppConfig } from "./config/configuration";
import { SHUTDOWN_TRACKER } from "./shutdown/shutdown.module";

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
  let app: INestApplication | undefined;
  // eslint-disable-next-line prefer-const
  let shutdownTracker: ShutdownOutcomeTracker | undefined;
  let earlySignal: NodeJS.Signals | undefined;

  // DEFECT-1F-001: previously absent entirely — without any signal
  // handling at all, a real SIGTERM/SIGINT to this process never
  // triggered OnModuleDestroy/OnApplicationShutdown, so
  // BackgroundJobsService's graceful shutdown path (and any future one)
  // simply never ran in production. This is the fix for that gap.
  //
  // Not app.enableShutdownHooks() itself — see apps/worker/src/main.ts's
  // identical, more detailed comment for why: that convenience method
  // re-delivers the original signal to itself after its hooks complete,
  // which terminates the process in a way that never consults
  // process.exitCode at all (confirmed by reading @nestjs/core's own
  // implementation and by a real spawned-process signal test, not
  // assumed). app.close() alone already fires the identical hook
  // sequence; registering our own signal handlers around it preserves
  // correct Unix signal-termination semantics for the common case
  // (GRACEFUL/FORCED) while still allowing a genuine FAILED outcome to
  // short-circuit with an explicit non-zero exit — see the Engineering
  // Plan's §5/§8 exit-code policy.
  async function runShutdown(nestApp: INestApplication, tracker: ShutdownOutcomeTracker, signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    // DEFECT-1F-001 final correction — see apps/worker/src/main.ts's
    // identical, more detailed comment for the full rationale.
    try {
      await nestApp.close();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "APPLICATION_SHUTDOWN_FAILED",
          service: "myev-api",
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

  // DEFECT-1F-001 SIGNAL-HANDLER READINESS RACE FIX — see
  // apps/worker/src/main.ts's identical, more detailed comment for the
  // full rationale. Registered before NestFactory.create() even starts,
  // not merely before app.listen(): this app's own statement order
  // already put signal registration before app.listen() (so /health
  // could never become reachable ahead of it), but registering here —
  // before any bootstrap work at all — makes the invariant structural
  // rather than incidental to today's statement order, and matches the
  // worker's own fix for uniformity and defense in depth.
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

  const resolvedApp = await NestFactory.create(AppModule, { bufferLogs: true });
  resolvedApp.useLogger(resolvedApp.get(Logger));
  resolvedApp.use(cookieParser());
  resolvedApp.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app = resolvedApp;
  shutdownTracker = resolvedApp.get<ShutdownOutcomeTracker>(SHUTDOWN_TRACKER);

  const config = resolvedApp.get(ConfigService<AppConfig, true>);
  const port = config.get("port", { infer: true });

  await resolvedApp.listen(port);

  // READINESS INVARIANT (DEFECT-1F-001 signal-handler readiness race
  // fix) — see apps/worker/src/main.ts's identical comment. By this
  // line, SIGTERM/SIGINT listeners have been armed AND the HTTP server
  // is actually accepting connections. Printed via raw console.log, not
  // the pino logger, so it is never silently dropped by LOG_LEVEL
  // filtering.
  console.log(JSON.stringify({ event: "APPLICATION_READY", service: "myev-api" }));

  if (earlySignal && app && shutdownTracker) {
    void runShutdown(app, shutdownTracker, earlySignal);
  }
}

bootstrap();
