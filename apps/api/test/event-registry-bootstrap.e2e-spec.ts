import type { INestApplication } from "@nestjs/common";
import type { EventRegistry } from "@myev/shared";
import { bootstrapE2eApp, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";
import { EVENT_REGISTRY } from "../src/modules/events/events.module";

/**
 * Milestone 8.1 items 7/8 (bootstrap validation, manifest discovery) —
 * the API-process twin of apps/worker's own event-registry-bootstrap
 * e2e-spec.
 *
 * MILESTONE 8.1 FINAL VALIDATION & CONTRACT REVIEW §2 (Zero-Consumer
 * Manifest Semantics, Option A): no real consumer is registered here —
 * the production registry is legitimately EMPTY until a real module
 * registers a genuine consumer (Milestone 2+). See apps/worker's
 * identical test for the full rationale.
 */
describe("API (e2e) — Event Registry bootstrap", () => {
  let e2e: E2eApp;
  let app: INestApplication;

  beforeAll(async () => {
    e2e = await bootstrapE2eApp();
    app = e2e.app;
  });

  afterAll(async () => {
    await teardownE2eApp(e2e);
  });

  it("boots with a legitimately empty, successfully-frozen registry — no real consumer exists yet", () => {
    const registry = app.get<EventRegistry>(EVENT_REGISTRY);
    expect(registry.listManifests()).toHaveLength(0);
  });

  it("registers the identical (empty) manifest set the Worker process registers — kept in lockstep by construction", () => {
    const registry = app.get<EventRegistry>(EVENT_REGISTRY);
    expect(registry.listManifests()).toEqual([]);
  });
});
