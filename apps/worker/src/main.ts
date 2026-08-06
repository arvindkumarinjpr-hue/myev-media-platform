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
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.flushLogs();
  app.enableShutdownHooks();
}

bootstrap().catch((error: unknown) => {
  // Logger is scoped inside bootstrap and may not exist yet if
  // configuration itself threw — this is the last-resort fallback path.
  console.error("worker failed to start:", error);
  process.exitCode = 1;
});
