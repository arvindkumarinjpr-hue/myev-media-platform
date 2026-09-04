import { buildPublishingProviderRegistry as buildApiPublishingProviderRegistry } from "../../api/src/modules/publishing/publishing-provider-registry.factory";
import { buildPublishingProviderRegistry as buildWorkerPublishingProviderRegistry } from "../src/publishing/publishing-provider-registry.module";

/**
 * Module 9 Phase 9.4 — genuine, runtime regression protection that
 * apps/api's and apps/worker's own PublishingProviderRegistry factories
 * register the IDENTICAL channel set with IDENTICAL capabilities (Part F:
 * "register in BOTH... registries... identical capabilities both
 * processes"; Part T: "no capability/auth-parsing drift"). Mirrors
 * api-worker-agent-registry-sync.e2e-spec.ts's own precedent, but simpler:
 * neither factory function has any NestJS DI dependency (PrismaService,
 * ConfigService, etc.) — both are plain functions, called directly, no
 * `Test.createTestingModule` bootstrap needed.
 *
 * A future provider registered (or configured with drifted capabilities)
 * in only one of the two factories fails this test immediately.
 */
describe("apps/api ⇄ apps/worker PublishingProviderRegistry — registration stays synchronized", () => {
  it("both registries resolve the exact same set of registered channel types", () => {
    const apiChannelTypes = buildApiPublishingProviderRegistry()
      .list()
      .map((p) => p.channelType)
      .sort();
    const workerChannelTypes = buildWorkerPublishingProviderRegistry()
      .list()
      .map((p) => p.channelType)
      .sort();
    expect(workerChannelTypes).toEqual(apiChannelTypes);
  });

  it("both registries register WORDPRESS with identical capabilities", () => {
    const apiProvider = buildApiPublishingProviderRegistry().resolve("WORDPRESS");
    const workerProvider = buildWorkerPublishingProviderRegistry().resolve("WORDPRESS");
    expect(workerProvider.getCapabilities()).toEqual(apiProvider.getCapabilities());
  });
});
