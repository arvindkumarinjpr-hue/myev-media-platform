import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ContentDimensionRegistryModule } from "./content-dimension-registry.module";
import { ContentScoringController } from "./content-scoring.controller";
import { ContentScoringService } from "./content-scoring.service";
import { ScoringInputBuilder } from "./scoring-input-builder";

/**
 * Module 6 Phase 6.1 — Content Scoring Engine (shared foundation).
 *
 * The API-side wiring around @myev/shared's content-scoring contract:
 *  - ContentDimensionRegistryModule: the one frozen registry (Blog only
 *    in this phase; Module 7 adds Video/Thumbnail there).
 *  - ScoringInputBuilder: normalizes a Module 1E content item + optional
 *    Knowledge Pack context into the shared ScoringInput.
 *  - ContentScoringService: resolves a dimension, runs the shared
 *    engine, persists content_scores + seo_reports.
 *
 * AuthModule import mirrors ContentModule/MediaAssetsModule: the
 * controller's SessionGuard needs JwtService, which AuthModule exports.
 * PermissionGuard/RbacModule are @Global.
 */
@Module({
  imports: [AuthModule, ContentDimensionRegistryModule],
  controllers: [ContentScoringController],
  providers: [ContentScoringService, ScoringInputBuilder],
  exports: [ContentScoringService],
})
export class ContentScoringModule {}
