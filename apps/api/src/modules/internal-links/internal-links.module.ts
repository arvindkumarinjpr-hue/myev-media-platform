import { Module } from "@nestjs/common";
import { ContentScoringModule } from "../content-scoring/content-scoring.module";
import { InternalLinkAnchorService } from "./internal-link-anchor.service";
import { InternalLinkDiscoveryService } from "./internal-link-discovery.service";
import { InternalLinksService } from "./internal-links.service";

/**
 * Module 8 — AI Internal Linking Engine: Domain + Persistence Foundation
 * (Phase 8.1) + Candidate Discovery + Relevance Engine (Phase 8.2) +
 * Anchor Recommendation Engine (Phase 8.3).
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
  providers: [InternalLinksService, InternalLinkDiscoveryService, InternalLinkAnchorService],
  exports: [InternalLinksService, InternalLinkDiscoveryService, InternalLinkAnchorService],
})
export class InternalLinksModule {}
