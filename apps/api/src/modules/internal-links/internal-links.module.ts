import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ContentScoringModule } from "../content-scoring/content-scoring.module";
import { BlogInternalLinksController } from "./blog-internal-links.controller";
import { InternalLinkAnchorService } from "./internal-link-anchor.service";
import { InternalLinkDiscoveryService } from "./internal-link-discovery.service";
import { InternalLinkIntelligenceService } from "./internal-link-intelligence.service";
import { InternalLinksController } from "./internal-links.controller";
import { InternalLinksQueryService } from "./internal-links-query.service";
import { InternalLinksService } from "./internal-links.service";

/**
 * Module 8 — AI Internal Linking Engine: Domain + Persistence Foundation
 * (Phase 8.1) + Candidate Discovery + Relevance Engine (Phase 8.2) +
 * Anchor Recommendation Engine (Phase 8.3) + Human Review API + Module 6
 * Blog Integration (Phase 8.4) + Orphan/Cluster Intelligence (Phase 8.5).
 *
 * AuthModule import mirrors BlogModule/ContentScoringModule: the
 * controllers' SessionGuard needs JwtService; PermissionGuard/RbacModule
 * are @Global(). ContentScoringModule is imported only for its exported,
 * read-only ContentScoringService (target-authority lookups via
 * getLatest() — never triggers scoring).
 *
 * Exports InternalLinkDiscoveryService for BlogModule to inject into
 * BlogPipelineService (the Phase 8.4 seam integration) — BlogModule
 * importing InternalLinksModule creates no circular dependency:
 * InternalLinksModule never imports BlogModule.
 */
@Module({
  imports: [AuthModule, ContentScoringModule],
  controllers: [BlogInternalLinksController, InternalLinksController],
  providers: [InternalLinksService, InternalLinkDiscoveryService, InternalLinkAnchorService, InternalLinksQueryService, InternalLinkIntelligenceService],
  exports: [InternalLinksService, InternalLinkDiscoveryService, InternalLinkAnchorService, InternalLinksQueryService, InternalLinkIntelligenceService],
})
export class InternalLinksModule {}
