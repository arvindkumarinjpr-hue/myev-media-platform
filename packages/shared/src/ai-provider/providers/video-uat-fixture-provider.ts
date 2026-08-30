import { AIProviderError, AIProviderErrorCode } from "../ai-provider-error";
import type { AIModelCapability, AIProvider } from "../ai-provider.interface";
import type { AIRequest } from "../ai-request";
import type { AIResponse } from "../ai-response";
import { parseStructuredOutput } from "../structured-output";

/**
 * Module 7 Phase 7.7 closure — a deterministic, zero-spend, zero-network
 * AIProvider that returns a fixed, schema-valid response for each of the
 * six Video Automation agents, keyed off `request.agentName`.
 *
 * Purpose: let a full Video pipeline (brief -> script -> Gate #1 approval
 * -> scene plan -> SEO, plus the two advisory agents) run on a staging /
 * UAT environment that has NO external AI-provider credentials, so the
 * mandatory real-Remotion-render + real-QA staging UAT can be exercised
 * end to end. It is NOT a test of AI providers.
 *
 * It changes nothing about the execution path: the AI job still goes
 * through the real BullMQ queue, the real `ai-execute` processor, the
 * real `resolveAgentExecution`, this real `provider.execute()`, the real
 * `parseStructuredOutput` schema validation, the real
 * `AgentDefinition.postProcessOutput` (e.g. the scene-plan cross-field
 * checks), real persistence, and the real pipeline reconcile + gate
 * derivation. The ONLY thing replaced is the outbound HTTPS call to a
 * real LLM vendor.
 *
 * Gating (enforced by the two `buildAiProviderRegistry` factories, not
 * here): registered ONLY when `env !== "production"` AND no real
 * `OPENAI_API_KEY` is set — so it can never shadow a configured provider
 * and is structurally impossible to activate in production.
 *
 * The fixture values are the exact ones the render/QA golden-path E2E
 * suite (`apps/api/test/video-render-qa.e2e-spec.ts`) already uses, so
 * downstream behaviour matches a scenario that is already covered.
 */

const BRIEF = {
  objective: "Show a new EV owner how to start home charging.",
  audience: "New EV owners",
  targetPlatform: "YOUTUBE_LONG",
  durationSeconds: 60,
  cta: "Book an assessment.",
  rationale: "How-to angle for a new owner's first week.",
};

const SCRIPT = {
  hook: "Charging your EV at home is easier than you think.",
  segments: [
    { order: 1, id: "seg-1", label: "Hook", narration: "Charging your EV at home is easier than you think.", purpose: "hook" },
    { order: 2, id: "seg-2", label: "Setup", narration: "Plug in, pick a schedule, and wake up full.", purpose: "steps" },
  ],
  cta: "Book a free install assessment.",
  scriptBody: "HOOK\n[seg-1] Hook\n[seg-2] Setup\nCTA",
};

const SCENE_PLAN = {
  scenePlanVersion: 1,
  targetPlatform: "YOUTUBE_LONG",
  scenes: [
    {
      order: 1,
      sceneId: "scene-1",
      scriptSegmentRef: "seg-1",
      startSeconds: 0,
      durationSeconds: 4,
      visualInstruction: "Hands plugging in a charger.",
      transition: "cut",
      assetRequirements: [{ kind: "image", description: "Plugging in", sourceHint: "ai_generated" }],
    },
    {
      order: 2,
      sceneId: "scene-2",
      scriptSegmentRef: "seg-2",
      startSeconds: 4,
      durationSeconds: 4,
      visualInstruction: "Phone app schedule.",
      transition: "fade",
      assetRequirements: [{ kind: "image", description: "App UI", sourceHint: "ai_generated" }],
    },
  ],
};

const SEO = {
  metaTitle: "Home EV Charging Guide",
  metaDescription: "Everything a new owner needs to start charging at home.",
  tags: ["ev charging", "home charging"],
  chapters: [{ startSeconds: 0, title: "Intro" }],
  hashtags: ["#ev", "#evcharging"],
  schemaMarkup: { "@type": "VideoObject", name: "Home EV Charging Guide", description: "A short how-to for new EV owners.", duration: "PT1M0S" },
};

const THUMBNAIL_CONCEPTS = {
  concepts: [
    { title: "Shocked reaction + low bill", visualDirection: "Owner pointing at a small utility bill, wide-eyed.", overlayText: "THIS CHEAP?!", composition: "Face left third, bill right, high contrast.", ctrHypothesis: "Curiosity gap on cost drives the click." },
    { title: "Before / after", visualDirection: "Split screen: gas pump vs. home charger.", overlayText: "NEVER AGAIN", composition: "Vertical 50/50 split, bold centre text.", ctrHypothesis: "Instant visual contrast reads at thumbnail size." },
  ],
};

const RECOMMENDATIONS = {
  recommendations: [
    { kind: "stronger_hook", suggestion: "Open on the cost number, not the process.", rationale: "The brief's audience is cost-motivated first-week owners." },
    { kind: "shorter_intro", suggestion: "Cut the channel intro to under 3 seconds.", rationale: "Short-form retention on how-to content drops fast before the payoff." },
  ],
};

const FIXTURES: Record<string, Record<string, unknown>> = {
  "video-brief-agent": BRIEF,
  "video-script-agent": SCRIPT,
  "video-scene-planner-agent": SCENE_PLAN,
  "video-seo-metadata-agent": SEO,
  "thumbnail-concept-agent": THUMBNAIL_CONCEPTS,
  "video-recommendations-agent": RECOMMENDATIONS,
};

export class VideoUatFixtureProvider implements AIProvider {
  readonly id: string;

  constructor(id = "video-uat-fixture") {
    this.id = id;
  }

  async execute(request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    if (signal?.aborted) {
      throw new AIProviderError(AIProviderErrorCode.TIMEOUT, "Request was aborted before the fixture provider could respond.", this.id);
    }

    const fixture = request.agentName ? FIXTURES[request.agentName] : undefined;
    if (!fixture) {
      throw new AIProviderError(
        AIProviderErrorCode.INVALID_REQUEST,
        `VideoUatFixtureProvider has no fixture for agent "${request.agentName ?? "(none)"}" — it only serves the six Video Automation agents.`,
        this.id,
      );
    }

    // Validate/normalise against the agent's own output schema exactly
    // the way a real structured response is handled — a fixture that
    // drifts out of shape fails here, not silently downstream.
    const output = request.structuredOutputSchema
      ? ((await parseStructuredOutput(JSON.stringify(fixture), request.structuredOutputSchema, this.id)) as Record<string, unknown>)
      : fixture;

    return {
      provider: this.id,
      model: "video-uat-fixture-1",
      requestId: `video-uat-fixture-${request.correlationId ?? "no-correlation-id"}`,
      usage: { tokensIn: 0, tokensOut: 0, tokensTotal: 0 },
      executionTimeMs: 1,
      finishReason: "stop",
      correlationId: request.correlationId,
      output,
    };
  }

  getCapabilities(): AIModelCapability[] {
    return [{ model: "video-uat-fixture-1", capability: "chat" }];
  }
}
