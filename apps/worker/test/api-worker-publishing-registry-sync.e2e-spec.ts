import { buildPublishingProviderRegistry as buildApiPublishingProviderRegistry } from "../../api/src/modules/publishing/publishing-provider-registry.factory";
import { buildPublishingProviderRegistry as buildWorkerPublishingProviderRegistry } from "../src/publishing/publishing-provider-registry.module";

const CONFIGURED_YOUTUBE = { oauthClientId: "test-client-id", oauthClientSecret: "test-client-secret" };
const UNCONFIGURED_YOUTUBE = { oauthClientId: "", oauthClientSecret: "" };

/**
 * Module 9 Phase 9.4/9.5 — genuine, runtime regression protection that
 * apps/api's and apps/worker's own PublishingProviderRegistry factories
 * register the IDENTICAL channel set with IDENTICAL capabilities (Part F/
 * Part G of Phase 9.5: "register in BOTH... registries... identical
 * capabilities both processes"; Part T: "no capability/auth-parsing
 * drift"). Mirrors api-worker-agent-registry-sync.e2e-spec.ts's own
 * precedent, but simpler: neither factory function has any NestJS DI
 * dependency beyond the plain `youtube` config object both now accept —
 * both are plain functions, called directly, no `Test.createTestingModule`
 * bootstrap needed.
 *
 * A future provider registered (or configured with drifted capabilities)
 * in only one of the two factories fails this test immediately.
 */
describe("apps/api ⇄ apps/worker PublishingProviderRegistry — registration stays synchronized", () => {
  it("both registries resolve the exact same set of registered channel types when YouTube IS configured", () => {
    const apiChannelTypes = buildApiPublishingProviderRegistry(CONFIGURED_YOUTUBE)
      .list()
      .map((p) => p.channelType)
      .sort();
    const workerChannelTypes = buildWorkerPublishingProviderRegistry(CONFIGURED_YOUTUBE)
      .list()
      .map((p) => p.channelType)
      .sort();
    expect(workerChannelTypes).toEqual(apiChannelTypes);
    expect(apiChannelTypes).toEqual(["WORDPRESS", "YOUTUBE"]);
  });

  it("both registries resolve the exact same (WordPress-only) set when YouTube is NOT configured", () => {
    const apiChannelTypes = buildApiPublishingProviderRegistry(UNCONFIGURED_YOUTUBE)
      .list()
      .map((p) => p.channelType)
      .sort();
    const workerChannelTypes = buildWorkerPublishingProviderRegistry(UNCONFIGURED_YOUTUBE)
      .list()
      .map((p) => p.channelType)
      .sort();
    expect(workerChannelTypes).toEqual(apiChannelTypes);
    expect(apiChannelTypes).toEqual(["WORDPRESS"]);
  });

  it("both registries register WORDPRESS with identical capabilities", () => {
    const apiProvider = buildApiPublishingProviderRegistry(CONFIGURED_YOUTUBE).resolve("WORDPRESS");
    const workerProvider = buildWorkerPublishingProviderRegistry(CONFIGURED_YOUTUBE).resolve("WORDPRESS");
    expect(workerProvider.getCapabilities()).toEqual(apiProvider.getCapabilities());
  });

  it("both registries register YOUTUBE with identical capabilities", () => {
    const apiProvider = buildApiPublishingProviderRegistry(CONFIGURED_YOUTUBE).resolve("YOUTUBE");
    const workerProvider = buildWorkerPublishingProviderRegistry(CONFIGURED_YOUTUBE).resolve("YOUTUBE");
    expect(workerProvider.getCapabilities()).toEqual(apiProvider.getCapabilities());
  });
});
