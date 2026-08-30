import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplicationContext } from "@nestjs/common";
import { Logger } from "nestjs-pino";
import type { ShutdownOutcomeTracker } from "@myev/shared";
import { SHUTDOWN_TRACKER } from "./shutdown/shutdown.module";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NestAppModule = any;

/**
 * Worker process bootstrap — a NestJS application context, no HTTP
 * listener (frozen Module 1F Engineering Plan). Shared verbatim by the
 * general worker (`apps/worker`) and the dedicated render/media worker
 * (`apps/render-worker`); the only difference is the AppModule and the
 * service name stamped into structured logs. Every DEFECT-1F-001 signal-
 * handling / bounded-shutdown / readiness-race property is preserved.
 */
export async function bootstrapWorker(appModule: NestAppModule, serviceName: string): Promise<void> {
  const shutdownSignals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  let shuttingDown = false;
  // eslint-disable-next-line prefer-const
  let app: INestApplicationContext | undefined;
  // eslint-disable-next-line prefer-const
  let shutdownTracker: ShutdownOutcomeTracker | undefined;
  let earlySignal: NodeJS.Signals | undefined;

  async function runShutdown(nestApp: INestApplicationContext, tracker: ShutdownOutcomeTracker, signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await nestApp.close();
    } catch (error) {
      console.error(
        JSON.stringify({ event: "APPLICATION_SHUTDOWN_FAILED", service: serviceName, signal, err: { message: error instanceof Error ? error.message : String(error) } }),
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

  // DEFECT-1F-001 signal-handler readiness race fix — armed before Nest
  // begins resolving, so a signal arriving mid-bootstrap is deferred,
  // never lost.
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

  const resolvedApp = await NestFactory.createApplicationContext(appModule, { bufferLogs: true });
  resolvedApp.useLogger(resolvedApp.get(Logger));
  resolvedApp.flushLogs();
  app = resolvedApp;
  shutdownTracker = resolvedApp.get<ShutdownOutcomeTracker>(SHUTDOWN_TRACKER);

  // READINESS INVARIANT — every OnApplicationBootstrap hook has run.
  // Raw console.log so it survives LOG_LEVEL filtering.
  console.log(JSON.stringify({ event: "APPLICATION_READY", service: serviceName }));

  if (earlySignal && app && shutdownTracker) {
    void runShutdown(app, shutdownTracker, earlySignal);
  }
}
