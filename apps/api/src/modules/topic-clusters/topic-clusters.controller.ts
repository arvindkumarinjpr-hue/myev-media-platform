import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { TopicClustersService } from "./topic-clusters.service";
import { CreateTopicClusterDto } from "./dto/create-topic-cluster.dto";

// Mirrors the shape a caller actually needs: the keyword breakdown
// grouped back into primary/secondary (the DB stores it as a flat
// membership junction), real source-research/Knowledge-Pack provenance,
// and the content series it's attached to, if any. Never a raw internal
// id, never a raw Prisma row.
function serialize(cluster: {
  publicId: string;
  name: string;
  createdAt: Date;
  keywordCluster: {
    publicId: string;
    topic: string;
    sourceAiJob: { publicId: string };
    knowledgePack: { publicId: string };
    members: { membership: string; keyword: { term: string; searchIntent: string; opportunityScore: number; rationale: string } }[];
  };
  contentSeries: { publicId: string; name: string } | null;
}) {
  // Never the raw Keyword row — it carries internal id/workspaceId/
  // publicId fields no caller needs, matching every other serialize()
  // in this codebase.
  const serializeKeyword = (k: { term: string; searchIntent: string; opportunityScore: number; rationale: string }) => ({
    term: k.term,
    searchIntent: k.searchIntent,
    opportunityScore: k.opportunityScore,
    rationale: k.rationale,
  });
  const primaryKeywords = cluster.keywordCluster.members.filter((m) => m.membership === "PRIMARY").map((m) => serializeKeyword(m.keyword));
  const secondaryKeywords = cluster.keywordCluster.members.filter((m) => m.membership === "SECONDARY").map((m) => serializeKeyword(m.keyword));
  return {
    publicId: cluster.publicId,
    name: cluster.name,
    clusterTopic: cluster.keywordCluster.topic,
    primaryKeywords,
    secondaryKeywords,
    sourceResearchId: cluster.keywordCluster.sourceAiJob.publicId,
    knowledgePackVersionId: cluster.keywordCluster.knowledgePack.publicId,
    contentSeries: cluster.contentSeries ? { publicId: cluster.contentSeries.publicId, name: cluster.contentSeries.name } : null,
    createdAt: cluster.createdAt,
  };
}

@Controller("api/v1/workspaces/:workspaceId/topic-clusters")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class TopicClustersController {
  constructor(private readonly topicClusters: TopicClustersService) {}

  @Post()
  @RequirePermission(PERMISSIONS.TOPIC_CLUSTER_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: CreateTopicClusterDto, @Req() req: Request) {
    const cluster = await this.topicClusters.create(workspace, workspace.userInternalId, dto, { ipAddress: req.ip });
    return { data: serialize(cluster) };
  }

  @Get()
  @RequirePermission(PERMISSIONS.TOPIC_CLUSTER_MANAGE)
  async list(@CurrentWorkspace() workspace: WorkspaceContext, @Query("contentSeriesId") contentSeriesId?: string) {
    const clusters = await this.topicClusters.list(workspace.id, { contentSeriesId });
    return { data: clusters.map(serialize) };
  }

  @Get(":topicClusterId")
  @RequirePermission(PERMISSIONS.TOPIC_CLUSTER_MANAGE)
  async findOne(@CurrentWorkspace() workspace: WorkspaceContext, @Param("topicClusterId") topicClusterId: string) {
    const cluster = await this.topicClusters.findOne(workspace.id, topicClusterId);
    return { data: serialize(cluster) };
  }
}
