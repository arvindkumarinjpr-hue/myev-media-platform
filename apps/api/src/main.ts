import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { ValidationPipe } from "@nestjs/common";
import { Logger } from "nestjs-pino";
import cookieParser from "cookie-parser";
import type { ShutdownOutcomeTracker } from "@myev/shared";
import { AppModule } from "./app.module";
import type { AppConfig } from "./config/configuration";
import { SHUTDOWN_TRACKER } from "./shutdown/shutdown.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

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
  const shutdownTracker = app.get<ShutdownOutcomeTracker>(SHUTDOWN_TRACKER);
  const shutdownSignals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  let shuttingDown = false;
  for (const signal of shutdownSignals) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async () => {
        // DEFECT-1F-001 final correction — see apps/worker/src/main.ts's
        // identical, more detailed comment for the full rationale.
        try {
          await app.close();
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
        if (shutdownTracker.hasFailure()) {
          process.exit(1);
          return;
        }
        for (const sig of shutdownSignals) process.removeAllListeners(sig);
        process.kill(process.pid, signal);
      })();
    });
  }

  const config = app.get(ConfigService<AppConfig, true>);
  const port = config.get("port", { infer: true });

  await app.listen(port);
}

bootstrap();
