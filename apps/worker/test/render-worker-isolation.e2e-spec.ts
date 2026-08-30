import { Test, type TestingModule } from "@nestjs/testing";
import type { QueueRegistry } from "@myev/shared";
import { AppModule } from "../src/app.module";
import { QUEUE_REGISTRY } from "../src/queue/queue-registry.module";

/**
 * Module 7 Phase 7.5 — render-worker isolation (checkpoint §27).
 *
 * A GENERAL worker (WORKER_QUEUES=SYSTEM,AI — no MEDIA) must NOT
 * register a handler for the render job or any MEDIA job: a render
 * failure can never touch the general worker because it never executes
 * one. The manifests are still REGISTERED (so any process could enqueue)
 * but no handler is bound, and the freeze bijection — scoped to this
 * worker's own queues — still holds.
 */
describe("Worker (e2e) — render-worker isolation (general SYSTEM/AI worker)", () => {
  // Deliberately NOT MEDIA.
  process.env.WORKER_QUEUES = "SYSTEM,AI";
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

  it("the general worker registers the render + media manifests but binds NO handler for them", () => {
    for (const jobType of ["media.video-render.v1", "media.image-generate.v1", "media.tts.v1", "media.subtitle-generate.v1"]) {
      expect(registry.getManifest(jobType)).toBeDefined();
      expect(registry.getHandler(jobType)).toBeUndefined();
    }
  });

  it("the general worker still binds its own SYSTEM/AI handlers", () => {
    expect(registry.getHandler("system.ping.v1")).toBeDefined();
    expect(registry.getHandler("ai.execute.v1")).toBeDefined();
  });

  it("the frozen registry's handler↔manifest bijection holds for the general worker's own queues", () => {
    // freeze({ requireHandlersForQueues: ["SYSTEM","AI"] }) succeeded during
    // module init above — reaching this line at all proves it. Re-assert
    // the render manifest's queue is MEDIA (out of this worker's scope).
    expect(registry.getManifest("media.video-render.v1")?.queue).toBe("MEDIA");
  });
});
