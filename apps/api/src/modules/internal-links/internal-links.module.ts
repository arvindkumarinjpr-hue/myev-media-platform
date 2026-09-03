import { Module } from "@nestjs/common";
import { ContentScoringModule } from "../content-scoring/content-scoring.module";
import { InternalLinkDiscoveryService } from "./internal-link-discovery.service";
import { InternalLinksService } from "./internal-links.service";

/**
 * Module 8 — AI Internal Linking Engine: Domain + Persistence Foundation
 * (Phase 8.1) + Candidate Discovery + Relevance Engine (Phase 8.2).
 *
 * No controller yet — PrismaService/AuditService are both @Global(), so
 * no explicit import is needed for those, mirroring TopicClustersModule/
 * ContentScoringModule's own minimal imports list. ContentScoringModule
 * is imported only for its exported, read-only ContentScoringService
 * (target-authority lookups via getLatest() — never triggers scoring).
 * The HTTP surface (generate/list/patch-anchor/accept/reject/orphans,
 * SEO_EDIT/BLOG_VIEW-gated) lands in Phase 8.4.
 */
@Module({
  imports: [ContentScoringModule],
  providers: [InternalLinksService, InternalLinkDiscoveryService],
  exports: [InternalLinksService, InternalLinkDiscoveryService],
})
export class InternalLinksModule {}
