import { Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { RESEARCH_AGENT_V1 } from "@myev/shared";
import type { AiJob } from "../../../generated/prisma";
import { AiJobSubmissionService } from "../ai-jobs/ai-job-submission.service";
import { KnowledgePacksService } from "../knowledge-packs/knowledge-packs.service";
import type { CreateResearchDto } from "./dto/create-research.dto";
import { RESEARCH_SOURCE_PROVIDER, type ResearchSourceProvider } from "./research-source-provider.interface";

export type ResearchJob = AiJob & { knowledgePack: { publicId: string } };

/**
 * Module 4 Phase 4.1 — the user-facing Research workflow. A thin
 * wrapper around Module 3's existing generic AiJobSubmissionService
 * (never a second AI execution system): this service's own job is
 * exactly the two things generic to every AiJob submission but specific
 * to Research's own FRD requirements —
 *
 * 1. FR-RES-002's "Source URL reachability check before inclusion":
 *    resolves the Knowledge Pack's Trusted Sources here (once, before
 *    reachability checking, since that's real HTTP work not worth doing
 *    for a pack that turns out inactive) and threads the checked result
 *    into the agent's own input.verifiedSources — buildPrompt
 *    (synchronous, by Module 3's own AgentDefinition contract) can never
 *    do this check itself.
 * 2. A Research-shaped list/read surface (agentIdentifier fixed to
 *    "research-agent") over Module 3's generic AiJob read model.
 */
@Injectable()
export class ResearchService {
  constructor(
    private readonly knowledgePacks: KnowledgePacksService,
    @Inject(RESEARCH_SOURCE_PROVIDER) private readonly sourceProvider: ResearchSourceProvider,
    private readonly aiJobs: AiJobSubmissionService,
  ) {}

  async submit(workspaceId: string, actorUserId: string, dto: CreateResearchDto, correlationId: string): Promise<ResearchJob> {
    // Enumeration-safe: findOne() throws NotFoundException identically
    // for "no such pack" and "exists in a different workspace" (Module
    // 2/3's own established convention, reused verbatim).
    const pack = await this.knowledgePacks.findOne(workspaceId, dto.knowledgePackVersionId);
    if (pack.status !== "ACTIVE") {
      // FR-RES-001's own error condition: "No active Knowledge Pack -> 422."
      throw new UnprocessableEntityException({
        code: "RESEARCH_KNOWLEDGE_PACK_NOT_ACTIVE",
        message: `Knowledge Pack is "${pack.status}", not ACTIVE — research cannot run against it.`,
      });
    }

    // A validated ACTIVE pack is guaranteed >= 1 trusted source (Module
    // 2's own KP_VALIDATE gate requires it) — the reachability check
    // itself still classifies each one; a source can pass KP validation
    // (a syntactically valid URL was configured) and still be
    // unreachable right now.
    const checked = await this.sourceProvider.checkReachable(pack.knowledgeSources.map((s) => ({ url: s.url, sourceType: s.sourceType })));
    // Module 4 Phase 4.3 — a stable, per-run source ID assigned here
    // (never derived from or guessable by the model) is what makes
    // RESEARCH_AGENT_V1's own citation enforcement structural rather
    // than a prompt-only promise: the model can only ever cite an ID it
    // was actually handed, never invent one that resolves to a real,
    // verified source.
    const verifiedSources = checked.map((s, i) => ({ sourceId: `S${i + 1}`, ...s }));

    const job = await this.aiJobs.submit(
      workspaceId,
      actorUserId,
      {
        agentIdentifier: RESEARCH_AGENT_V1.identifier,
        agentVersion: RESEARCH_AGENT_V1.version,
        knowledgePackVersionId: dto.knowledgePackVersionId,
        input: {
          topic: dto.topic,
          objective: dto.objective,
          geography: dto.geography,
          language: dto.language,
          seedKeywords: dto.seedKeywords,
          verifiedSources,
        },
      },
      correlationId,
    );

    return job;
  }

  async findOne(workspaceId: string, researchPublicId: string): Promise<ResearchJob> {
    return this.aiJobs.findOne(workspaceId, researchPublicId);
  }

  async list(workspaceId: string): Promise<ResearchJob[]> {
    return this.aiJobs.findMany(workspaceId, { agentIdentifier: RESEARCH_AGENT_V1.identifier });
  }
}
