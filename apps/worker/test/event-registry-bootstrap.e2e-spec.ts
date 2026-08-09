import { Test, type TestingModule } from "@nestjs/testing";
import type { EventRegistry } from "@myev/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { WorkerHeartbeatService } from "../src/heartbeat/worker-heartbeat.service";
import { EVENT_REGISTRY } from "../src/events/events.module";

/**
 * Milestone 8.1 items 7/8 (bootstrap validation, manifest discovery) —
 * proves EventsModule's EVENT_REGISTRY factory provider is genuinely
 * resolved during real Nest application-context construction
 * (Test.createTestingModule({...}).compile() + moduleRef.init() runs the
 * identical bootstrap path NestFactory.createApplicationContext() runs
 * in production, including EventRegistryBuilder.freeze()'s own
 * validation), not merely unit-tested in isolation.
 *
 * MILESTONE 8.1 FINAL VALIDATION & CONTRACT REVIEW §2 (Zero-Consumer
 * Manifest Semantics, Option A): no real consumer is registered here —
 * the production registry is legitimately EMPTY until a real module
 * registers a genuine consumer (Milestone 2+). This test proves that is
 * a valid, successfully-freezable bootstrap state, not an error — the
 * mechanics of registration/validation/duplicate-detection themselves
 * are proven by @myev/shared's own unit tests
 * (event-registry.spec.ts, event-version-contract.spec.ts), which use a
 * test-only fixture never wired into this real AppModule.
 */
describe("Worker (e2e) — Event Registry bootstrap", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let heartbeat: WorkerHeartbeatService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    heartbeat = moduleRef.get(WorkerHeartbeatService);
  });

  afterAll(async () => {
    await prisma.workerHeartbeat.deleteMany({ where: { workerId: heartbeat.workerId } });
    await moduleRef.close();
  });

  it("boots with a legitimately empty, successfully-frozen registry — no real consumer exists yet", () => {
    const registry = moduleRef.get<EventRegistry>(EVENT_REGISTRY);
    expect(registry.listManifests()).toHaveLength(0);
  });

  it("returns the same frozen registry instance across resolutions — EventsModule is @Global, singleton-scoped", () => {
    const first = moduleRef.get<EventRegistry>(EVENT_REGISTRY);
    const second = moduleRef.get<EventRegistry>(EVENT_REGISTRY);
    expect(first).toBe(second);
  });

  it("EventRegistry exposes no mutator at the real DI-resolved instance either — structural immutability holds end-to-end", () => {
    const registry = moduleRef.get<EventRegistry>(EVENT_REGISTRY);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(registry))).not.toEqual(expect.arrayContaining(["registerManifest", "freeze"]));
  });
});
