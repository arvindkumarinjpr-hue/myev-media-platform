import "reflect-metadata";
import { VideoUatFixtureProvider } from "./video-uat-fixture-provider";
import { VideoBriefAgentOutput } from "../../agent-framework/agents/video-brief-agent";
import { VideoScriptAgentOutput } from "../../agent-framework/agents/video-script-agent";
import { VideoScenePlannerAgentOutput } from "../../agent-framework/agents/video-scene-planner-agent";
import { VideoSeoMetadataAgentOutput } from "../../agent-framework/agents/video-seo-metadata-agent";
import { ThumbnailConceptAgentOutput } from "../../agent-framework/agents/thumbnail-concept-agent";
import { VideoRecommendationsAgentOutput } from "../../agent-framework/agents/video-recommendations-agent";
import type { AIRequest } from "../ai-request";

function req(agentName: string, schema?: AIRequest["structuredOutputSchema"]): AIRequest {
  return {
    workspaceId: "ws-1",
    agentName,
    prompt: "irrelevant",
    correlationId: "corr-1",
    ...(schema ? { outputFormat: "json" as const, structuredOutputSchema: schema } : {}),
  };
}

describe("VideoUatFixtureProvider", () => {
  const provider = new VideoUatFixtureProvider("openai");

  it.each([
    ["video-brief-agent", VideoBriefAgentOutput],
    ["video-script-agent", VideoScriptAgentOutput],
    ["video-scene-planner-agent", VideoScenePlannerAgentOutput],
    ["video-seo-metadata-agent", VideoSeoMetadataAgentOutput],
    ["thumbnail-concept-agent", ThumbnailConceptAgentOutput],
    ["video-recommendations-agent", VideoRecommendationsAgentOutput],
  ])("returns schema-valid output for %s through the real parseStructuredOutput path", async (agentName, schema) => {
    const res = await provider.execute(req(agentName, schema as AIRequest["structuredOutputSchema"]));
    expect(res.provider).toBe("openai");
    expect(res.output).toBeTruthy();
    expect(res.usage.tokensTotal).toBe(0);
  });

  it("the scene plan fixture maps every scene to a real script segment and covers every segment", async () => {
    const res = await provider.execute(req("video-scene-planner-agent", VideoScenePlannerAgentOutput));
    const plan = res.output as { scenes: { sceneId: string; scriptSegmentRef: string }[] };
    expect(plan.scenes.map((s) => s.scriptSegmentRef).sort()).toEqual(["seg-1", "seg-2"]);
  });

  it("throws a clear INVALID_REQUEST for an agent it has no fixture for", async () => {
    await expect(provider.execute(req("blog-brief-agent"))).rejects.toThrow(/no fixture for agent/i);
  });

  it("respects an already-aborted signal", async () => {
    const c = new AbortController();
    c.abort();
    await expect(provider.execute(req("video-brief-agent"), c.signal)).rejects.toThrow(/aborted/i);
  });
});
