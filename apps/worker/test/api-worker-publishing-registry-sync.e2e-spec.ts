import { buildPublishingProviderRegistry as buildApiPublishingProviderRegistry } from "../../api/src/modules/publishing/publishing-provider-registry.factory";
import { buildPublishingProviderRegistry as buildWorkerPublishingProviderRegistry } from "../src/publishing/publishing-provider-registry.module";

const CONFIGURED_YOUTUBE = { oauthClientId: "test-client-id", oauthClientSecret: "test-client-secret" };
const UNCONFIGURED_YOUTUBE = { oauthClientId: "", oauthClientSecret: "" };
const CONFIGURED_META = { appId: "test-app-id" };
const UNCONFIGURED_META = { appId: "" };

/**
 * Module 9 Phase 9.4/9.5/9.6 — genuine, runtime regression protection that
 * apps/api's and apps/worker's own PublishingProviderRegistry factories
 * register the IDENTICAL channel set with IDENTICAL capabilities (Part T:
 * "no capability/auth-parsing drift"). Mirrors
 * api-worker-agent-registry-sync.e2e-spec.ts's own precedent, but
 * simpler: neither factory function has any NestJS DI dependency beyond
 * the plain `youtube`/`meta` config objects both now accept — both are
 * plain functions, called directly, no `Test.createTestingModule`
 * bootstrap needed.
 *
 * A future provider registered (or configured with drifted capabilities)
 * in only one of the two factories fails this test immediately.
 */
describe("apps/api ⇄ apps/worker PublishingProviderRegistry — registration stays synchronized", () => {
  it("both registries resolve the exact same full channel set when YouTube AND Facebook are configured", () => {
    const apiChannelTypes = buildApiPublishingProviderRegistry(CONFIGURED_YOUTUBE, CONFIGURED_META)
      .list()
      .map((p) => p.channelType)
      .sort();
    const workerChannelTypes = buildWorkerPublishingProviderRegistry(CONFIGURED_YOUTUBE, CONFIGURED_META)
      .list()
      .map((p) => p.channelType)
      .sort();
    expect(workerChannelTypes).toEqual(apiChannelTypes);
    expect(apiChannelTypes).toEqual(["FACEBOOK", "INSTAGRAM", "WORDPRESS", "YOUTUBE"]);
  });

  it("both registries resolve the exact same (WordPress + Instagram only) set when YouTube and Facebook are NOT configured", () => {
    const apiChannelTypes = buildApiPublishingProviderRegistry(UNCONFIGURED_YOUTUBE, UNCONFIGURED_META)
      .list()
      .map((p) => p.channelType)
      .sort();
    const workerChannelTypes = buildWorkerPublishingProviderRegistry(UNCONFIGURED_YOUTUBE, UNCONFIGURED_META)
      .list()
      .map((p) => p.channelType)
      .sort();
    expect(workerChannelTypes).toEqual(apiChannelTypes);
    expect(apiChannelTypes).toEqual(["INSTAGRAM", "WORDPRESS"]);
  });

  it("resolves a partial-configuration state independently per channel (Facebook off, YouTube on)", () => {
    const apiChannelTypes = buildApiPublishingProviderRegistry(CONFIGURED_YOUTUBE, UNCONFIGURED_META)
      .list()
      .map((p) => p.channelType)
      .sort();
    const workerChannelTypes = buildWorkerPublishingProviderRegistry(CONFIGURED_YOUTUBE, UNCONFIGURED_META)
      .list()
      .map((p) => p.channelType)
      .sort();
    expect(workerChannelTypes).toEqual(apiChannelTypes);
    expect(apiChannelTypes).toEqual(["INSTAGRAM", "WORDPRESS", "YOUTUBE"]);
  });

  it("both registries register WORDPRESS with identical capabilities", () => {
    const apiProvider = buildApiPublishingProviderRegistry(CONFIGURED_YOUTUBE, CONFIGURED_META).resolve("WORDPRESS");
    const workerProvider = buildWorkerPublishingProviderRegistry(CONFIGURED_YOUTUBE, CONFIGURED_META).resolve("WORDPRESS");
    expect(workerProvider.getCapabilities()).toEqual(apiProvider.getCapabilities());
  });

  it("both registries register YOUTUBE with identical capabilities", () => {
    const apiProvider = buildApiPublishingProviderRegistry(CONFIGURED_YOUTUBE, CONFIGURED_META).resolve("YOUTUBE");
    const workerProvider = buildWorkerPublishingProviderRegistry(CONFIGURED_YOUTUBE, CONFIGURED_META).resolve("YOUTUBE");
    expect(workerProvider.getCapabilities()).toEqual(apiProvider.getCapabilities());
  });

  it("both registries register FACEBOOK with identical capabilities", () => {
    const apiProvider = buildApiPublishingProviderRegistry(CONFIGURED_YOUTUBE, CONFIGURED_META).resolve("FACEBOOK");
    const workerProvider = buildWorkerPublishingProviderRegistry(CONFIGURED_YOUTUBE, CONFIGURED_META).resolve("FACEBOOK");
    expect(workerProvider.getCapabilities()).toEqual(apiProvider.getCapabilities());
  });

  it("both registries register INSTAGRAM with identical capabilities", () => {
    const apiProvider = buildApiPublishingProviderRegistry(CONFIGURED_YOUTUBE, CONFIGURED_META).resolve("INSTAGRAM");
    const workerProvider = buildWorkerPublishingProviderRegistry(CONFIGURED_YOUTUBE, CONFIGURED_META).resolve("INSTAGRAM");
    expect(workerProvider.getCapabilities()).toEqual(apiProvider.getCapabilities());
  });
});
