import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";

/**
 * Worker as a NestJS application context — no HTTP listener. Chosen (per
 * the frozen Module 1F Engineering Plan) to get fail-fast bootstrap
 * validation hooks (OnApplicationBootstrap), structured-logging
 * consistency with the API (shared nestjs-pino config shape), and direct
 * PrismaService reuse, all through the same DI/module system apps/api
 * already uses — without exposing any network surface.
 */
async function bootstrap(): Promise<void> {
  process.stderr.write(`[LIFECYCLE] BEFORE createApplicationContext t=${Date.now()}\n`);
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  process.stderr.write(`[LIFECYCLE] AFTER createApplicationContext t=${Date.now()}\n`);
  process.stderr.write(`[LIFECYCLE] BEFORE useLogger t=${Date.now()}\n`);
  app.useLogger(app.get(Logger));
  process.stderr.write(`[LIFECYCLE] BEFORE flushLogs t=${Date.now()}\n`);
  app.flushLogs();
  process.stderr.write(`[LIFECYCLE] AFTER flushLogs t=${Date.now()}\n`);
  app.enableShutdownHooks();
  process.stderr.write(`[LIFECYCLE] bootstrap() fully complete t=${Date.now()}\n`);
}

bootstrap().catch((error: unknown) => {
  // Logger is scoped inside bootstrap and may not exist yet if
  // configuration itself threw — this is the last-resort fallback path.
  process.stderr.write(`[LIFECYCLE] bootstrap() REJECTED t=${Date.now()} error=${String(error)}\n`);
  console.error("worker failed to start:", error);
  process.exitCode = 1;
});
