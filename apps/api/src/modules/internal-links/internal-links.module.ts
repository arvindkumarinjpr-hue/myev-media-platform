import { Module } from "@nestjs/common";
import { InternalLinksService } from "./internal-links.service";

/**
 * Module 8 Phase 8.1 — AI Internal Linking Engine: Domain + Persistence
 * Foundation.
 *
 * No controller in this phase (Module 8 Architecture Checkpoint
 * Correction, Phase 8.1 scope) — PrismaService/AuditService are both
 * @Global(), so no explicit import is needed for those, mirroring
 * TopicClustersModule/ContentScoringModule's own minimal imports list.
 * The HTTP surface (generate/list/patch-anchor/accept/reject/orphans,
 * SEO_EDIT/BLOG_VIEW-gated) lands in Phase 8.4.
 */
@Module({
  providers: [InternalLinksService],
  exports: [InternalLinksService],
})
export class InternalLinksModule {}
