import { Test, type TestingModule } from "@nestjs/testing";
import type { QueueRegistry } from "@myev/shared";
import { QUEUE_REGISTRY } from "@myev/worker-core";
import { AppModule } from "../src/app.module";

/**
 * Module 7 Phase 7.5 — TRUE render-worker isolation (checkpoint §27,
 * correction §I).
 *
 * The general worker (`apps/worker`) must NOT own the render pipeline at
 * ALL — not merely be filtered out of it by WORKER_QUEUES. It:
 *  - has NO `@remotion/*` / Chromium dependency in its package.json
 *    (asserted below by resolving its own manifest),
 *  - registers NO MEDIA manifest (image / voice / subtitle / video
 *    render) in its QueueRegistry,
 *  - binds NO handler for any of them,
 *  - still owns its own SYSTEM + AI handlers.
 *
 * A MEDIA job can never reach this process — it never opens a BullMQ
 * worker on the MEDIA queue — and `media.video-render.v1` and Remotion
 * are owned exclusively by `apps/render-worker`.
 */
describe("General worker (e2e) — media / render isolation", () => {
  process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM,AI";
  process.env.WORKER_APPLICATION_VERSION = "e2e-test";

  let moduleRef: TestingModule;
  let registry: QueueRegistry;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    registry = moduleRef.get(QUEUE_REGISTRY);
  });
  afterAll(async () => {
    await moduleRef.close();
  });

  it("registers NO MEDIA manifest and binds NO MEDIA handler", () => {
    for (const jobType of ["media.image-generate.v1", "media.tts.v1", "media.subtitle-generate.v1", "media.video-render.v1"]) {
      expect(registry.getManifest(jobType)).toBeUndefined();
      expect(registry.getHandler(jobType)).toBeUndefined();
    }
  });

  it("still owns its own SYSTEM + AI handlers", () => {
    expect(registry.getManifest("system.ping.v1")).toBeDefined();
    expect(registry.getHandler("system.ping.v1")).toBeDefined();
    expect(registry.getManifest("ai.execute.v1")).toBeDefined();
    expect(registry.getHandler("ai.execute.v1")).toBeDefined();
  });

  it("has no Remotion / Chromium dependency in its package manifest", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("../package.json") as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of Object.keys(all)) {
      expect(name.startsWith("@remotion/")).toBe(false);
      expect(name).not.toBe("remotion");
      expect(name).not.toBe("puppeteer");
      expect(name).not.toBe("puppeteer-core");
    }
  });
});
