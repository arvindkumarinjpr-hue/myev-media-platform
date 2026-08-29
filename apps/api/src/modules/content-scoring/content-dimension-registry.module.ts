import { Global, Module } from "@nestjs/common";
import { BLOG_DIMENSION_V1, THUMBNAIL_DIMENSION_V1, VIDEO_DIMENSION_V1, ContentDimensionRegistryBuilder, type ContentDimensionRegistry } from "@myev/shared";

export const CONTENT_DIMENSION_REGISTRY = Symbol("CONTENT_DIMENSION_REGISTRY");

/**
 * Module 6 Phase 6.1 — the frozen ContentDimensionRegistry, mirroring
 * AgentRegistryModule / QueueRegistryModule's exact
 * @Global / useFactory / freeze-once pattern.
 *
 * MODULE_ROADMAP_V1.0.md §11: the Content Scoring Engine is
 * content-type-AGNOSTIC. This is the single place dimensions are
 * registered. Module 7 adds `VIDEO_DIMENSION_V1` / `THUMBNAIL_DIMENSION_V1`
 * here — one `builder.register(...)` line each — and touches nothing
 * else (not the engine, not the Blog dimension, not ContentScoringService).
 *
 * Phase 6.1 registered exactly one dimension: Blog. Module 7 Phase 7.3
 * adds Video and Thumbnail here — two more `builder.register(...)`
 * lines, nothing else. VIDEO_DIMENSION_V1 (`appliesTo: ["VIDEO"]`) is
 * the ONE dimension `resolveForContentType("VIDEO")` resolves to —
 * unchanged Blog resolution semantics, now also covering Video.
 * THUMBNAIL_DIMENSION_V1 (`appliesTo: ["VIDEO_THUMBNAIL_CONCEPT"]`, a
 * logical identifier no real `content_items.content_type` row is ever
 * literally equal to) is deliberately unreachable via
 * `resolveForContentType` — `VideoScoringService` resolves it directly
 * by name (`resolve("thumbnail", 1)`) as a second, independent scoring
 * pass, so registering it here can never make `resolveForContentType`
 * throw "ambiguous" for any real ContentType. See video-dimension.ts /
 * thumbnail-dimension.ts's own doc comments for the full rationale.
 *
 * No test-only dimension is registered in the real DI graph (the
 * synthetic type-agnosticism dimension lives only in @myev/shared's
 * spec files).
 */
@Global()
@Module({
  providers: [
    {
      provide: CONTENT_DIMENSION_REGISTRY,
      useFactory: (): ContentDimensionRegistry => {
        const builder = new ContentDimensionRegistryBuilder();
        builder.register(BLOG_DIMENSION_V1);
        builder.register(VIDEO_DIMENSION_V1);
        builder.register(THUMBNAIL_DIMENSION_V1);
        return builder.freeze();
      },
    },
  ],
  exports: [CONTENT_DIMENSION_REGISTRY],
})
export class ContentDimensionRegistryModule {}
