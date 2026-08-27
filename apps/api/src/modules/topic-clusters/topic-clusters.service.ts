import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { KeywordCluster, KeywordClusterMembership, Prisma, SearchIntent } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AiJobSubmissionService } from "../ai-jobs/ai-job-submission.service";
import { ContentSeriesService } from "../content/content-series.service";
import type { CreateTopicClusterDto } from "./dto/create-topic-cluster.dto";

interface RequestContext {
  ipAddress?: string;
}

// The exact shape RESEARCH_AGENT_V1 (packages/shared) persists into
// ai_jobs.output_payload once postProcessOutput has run — read-only here,
// never re-validated against the agent's own class-validator schema
// (that already happened once, at Worker-execution time; this is a
// second, independent consumer of already-trusted, already-persisted
// data, not a re-entry into Module 3's own execution pipeline).
interface ResearchKeywordClusterMember {
  keyword: string;
  intent: "informational" | "transactional" | "navigational" | "unknown";
  opportunityScore: number;
  rationale: string;
}
interface ResearchKeywordCluster {
  clusterTopic: string;
  primaryKeywords: ResearchKeywordClusterMember[];
  secondaryKeywords: ResearchKeywordClusterMember[];
}
interface ResearchOutputShape {
  keywordClusters?: ResearchKeywordCluster[];
}

const INTENT_TO_SEARCH_INTENT: Record<string, SearchIntent> = {
  informational: "INFORMATIONAL",
  transactional: "TRANSACTIONAL",
  navigational: "NAVIGATIONAL",
  unknown: "UNKNOWN",
};

const WITH_BREAKDOWN = {
  keywordCluster: {
    include: {
      sourceAiJob: { select: { publicId: true } },
      knowledgePack: { select: { publicId: true } },
      members: { include: { keyword: true } },
    },
  },
  contentSeries: { select: { publicId: true, name: true } },
} satisfies Prisma.TopicClusterInclude;
type TopicClusterWithBreakdown = Prisma.TopicClusterGetPayload<{ include: typeof WITH_BREAKDOWN }>;

/**
 * Module 5 Phase 5.1 — Content Planner: Topic Cluster Planning
 * (FR-PLAN-002). Turns a completed Research run's already-AI-generated
 * keywordClusters[] into a real, persisted, plannable entity — never a
 * second AI call, never a new AgentDefinition/AiJob. The "planning
 * decision" is the human action of promoting one cluster (and,
 * optionally, attaching it to an existing Content Series); everything
 * else is deterministic materialization of data Module 4 already
 * computed and validated.
 */
@Injectable()
export class TopicClustersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiJobs: AiJobSubmissionService,
    private readonly contentSeries: ContentSeriesService,
    private readonly audit: AuditService,
  ) {}

  async create(workspace: { id: string }, actorUserId: string, dto: CreateTopicClusterDto, context: RequestContext): Promise<TopicClusterWithBreakdown> {
    // Enumeration-safe: findOne() throws identically for "no such job"
    // and "exists in a different workspace" (Module 3's own convention).
    const job = await this.aiJobs.findOne(workspace.id, dto.researchId);
    if (job.agentName !== "research-agent") {
      throw new UnprocessableEntityException({ code: "TOPIC_CLUSTER_SOURCE_NOT_RESEARCH", message: "The referenced job is not a Research run." });
    }
    if (job.status !== "COMPLETED") {
      throw new UnprocessableEntityException({
        code: "TOPIC_CLUSTER_RESEARCH_NOT_COMPLETED",
        message: `Research run is "${job.status}", not COMPLETED — nothing to plan from yet.`,
      });
    }

    const output = job.outputPayload as unknown as ResearchOutputShape | null;
    const sourceCluster = output?.keywordClusters?.find((c) => c.clusterTopic === dto.keywordClusterTopic);
    if (!sourceCluster) {
      throw new NotFoundException({ code: "TOPIC_CLUSTER_KEYWORD_CLUSTER_NOT_FOUND", message: "No keyword cluster with that topic exists in this Research run's own output." });
    }

    let contentSeriesInternalId: string | null = null;
    if (dto.contentSeriesId) {
      // Reuses Module 1E's own ContentSeriesService.findOne — never
      // duplicates its workspace-scoping/enumeration-safe-not-found logic.
      const series = await this.contentSeries.findOne(workspace.id, dto.contentSeriesId);
      contentSeriesInternalId = series.id;
    }

    return this.prisma.$transaction(async (tx) => {
      const keywordCluster = await this.materializeKeywordCluster(tx, workspace.id, job.id, job.knowledgePackId, actorUserId, sourceCluster);

      const existing = await tx.topicCluster.findUnique({ where: { keywordClusterId: keywordCluster.id } });
      if (existing) {
        throw new ConflictException({ code: "TOPIC_CLUSTER_ALREADY_EXISTS", message: "This keyword cluster has already been promoted to a Topic Cluster." });
      }

      const created = await tx.topicCluster.create({
        data: {
          workspaceId: workspace.id,
          name: dto.name?.trim() || sourceCluster.clusterTopic,
          keywordClusterId: keywordCluster.id,
          contentSeriesId: contentSeriesInternalId,
          createdById: actorUserId,
        },
        include: WITH_BREAKDOWN,
      });

      await this.audit.recordWithinTransaction(tx, {
        action: "TOPIC_CLUSTER_CREATED",
        actorUserId,
        workspaceId: workspace.id,
        entityType: "topic_cluster",
        entityId: created.publicId,
        ipAddress: context.ipAddress,
        correlationId: job.correlationId,
      });

      return created;
    });
  }

  async list(workspaceId: string, filters: { contentSeriesId?: string } = {}): Promise<TopicClusterWithBreakdown[]> {
    let contentSeriesInternalId: string | undefined;
    if (filters.contentSeriesId) {
      const series = await this.contentSeries.findOne(workspaceId, filters.contentSeriesId);
      contentSeriesInternalId = series.id;
    }
    return this.prisma.topicCluster.findMany({
      where: { workspaceId, ...(contentSeriesInternalId ? { contentSeriesId: contentSeriesInternalId } : {}) },
      include: WITH_BREAKDOWN,
      orderBy: { createdAt: "desc" },
    });
  }

  async findOne(workspaceId: string, topicClusterPublicId: string): Promise<TopicClusterWithBreakdown> {
    const cluster = await this.prisma.topicCluster.findFirst({ where: { workspaceId, publicId: topicClusterPublicId }, include: WITH_BREAKDOWN });
    if (!cluster) {
      throw new NotFoundException({ code: "TOPIC_CLUSTER_NOT_FOUND", message: "Topic cluster not found." });
    }
    return cluster;
  }

  /**
   * Idempotent: re-promoting the same Research run's same cluster topic
   * (e.g. a retried request) reuses the existing keywords/keyword_cluster/
   * keyword_cluster_members rows rather than duplicating them — the DB's
   * own unique constraints are the actual guarantee; this upsert logic
   * exists so a legitimate retry doesn't surface a raw constraint-
   * violation error to the caller.
   */
  private async materializeKeywordCluster(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    sourceAiJobId: string,
    knowledgePackId: string,
    actorUserId: string,
    sourceCluster: ResearchKeywordCluster,
  ): Promise<KeywordCluster> {
    const keywordCluster = await tx.keywordCluster.upsert({
      where: { workspaceId_sourceAiJobId_topic: { workspaceId, sourceAiJobId, topic: sourceCluster.clusterTopic } },
      create: { workspaceId, sourceAiJobId, knowledgePackId, topic: sourceCluster.clusterTopic, createdById: actorUserId },
      update: {},
    });

    const members: { member: ResearchKeywordClusterMember; membership: KeywordClusterMembership }[] = [
      ...sourceCluster.primaryKeywords.map((member) => ({ member, membership: "PRIMARY" as const })),
      ...sourceCluster.secondaryKeywords.map((member) => ({ member, membership: "SECONDARY" as const })),
    ];

    for (const { member, membership } of members) {
      const keyword = await tx.keyword.upsert({
        where: { workspaceId_term: { workspaceId, term: member.keyword } },
        create: {
          workspaceId,
          term: member.keyword,
          searchIntent: INTENT_TO_SEARCH_INTENT[member.intent] ?? "UNKNOWN",
          opportunityScore: member.opportunityScore,
          rationale: member.rationale,
        },
        update: {},
      });
      await tx.keywordClusterMember.upsert({
        where: { keywordClusterId_keywordId: { keywordClusterId: keywordCluster.id, keywordId: keyword.id } },
        create: { keywordClusterId: keywordCluster.id, keywordId: keyword.id, membership },
        update: {},
      });
    }

    return keywordCluster;
  }
}
