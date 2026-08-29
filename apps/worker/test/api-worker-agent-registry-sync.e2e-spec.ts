import { Test } from "@nestjs/testing";
import { AgentRegistryModule as WorkerAgentRegistryModule, AGENT_REGISTRY as WORKER_AGENT_REGISTRY } from "../src/ai-provider/agent-registry.module";
import { AgentRegistryModule as ApiAgentRegistryModule, AGENT_REGISTRY as API_AGENT_REGISTRY } from "../../api/src/modules/ai-agents/agent-registry.module";
import type { AgentRegistry } from "@myev/shared";

/**
 * Module 7 Phase 7.2 — genuine, runtime regression protection that
 * apps/api's AgentRegistryModule and apps/worker's own copy register the
 * IDENTICAL agent set. Every agent comment in both files says "registered
 * identically" — this test proves it by actually bootstrapping BOTH DI
 * modules (each is a leaf module: no PrismaService/ConfigService/other
 * app-internal dependency, so this cross-app import stays lightweight)
 * and comparing their resolved `identifier@version` sets, rather than
 * trusting the two source files to stay in sync by eye.
 *
 * A future agent registered in only one of the two modules — the exact
 * silent-drift failure mode both files' own doc comments warn about —
 * fails this test immediately.
 */
describe("apps/api ⇄ apps/worker AgentRegistryModule — registration stays synchronized", () => {
  async function listOf(moduleCls: new (...args: never[]) => unknown, token: symbol): Promise<string[]> {
    const moduleRef = await Test.createTestingModule({ imports: [moduleCls] }).compile();
    const registry = moduleRef.get<AgentRegistry>(token);
    const ids = registry.list().map((a) => `${a.identifier}@v${a.version}`);
    await moduleRef.close();
    return ids.sort();
  }

  it("both modules resolve the exact same set of registered agents", async () => {
    const apiIds = await listOf(ApiAgentRegistryModule, API_AGENT_REGISTRY);
    const workerIds = await listOf(WorkerAgentRegistryModule, WORKER_AGENT_REGISTRY);
    expect(workerIds).toEqual(apiIds);
  });

  it("both modules resolve every Module 7 Phase 7.2 video agent at v1", async () => {
    const expected = [
      "video-brief-agent@v1",
      "video-script-agent@v1",
      "video-scene-planner-agent@v1",
      "video-seo-metadata-agent@v1",
      "thumbnail-concept-agent@v1",
      "video-recommendations-agent@v1",
    ].sort();
    const apiIds = await listOf(ApiAgentRegistryModule, API_AGENT_REGISTRY);
    const workerIds = await listOf(WorkerAgentRegistryModule, WORKER_AGENT_REGISTRY);
    for (const id of expected) {
      expect(apiIds).toContain(id);
      expect(workerIds).toContain(id);
    }
  });
});
