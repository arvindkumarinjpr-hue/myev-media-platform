import { Injectable } from "@nestjs/common";
import type { ScoringInput, ThumbnailConceptAgentOutput, VideoScenePlannerAgentOutput, VideoScriptAgentOutput } from "@myev/shared";
import type { VideoPipelineState } from "./video-pipeline.types";

export interface KnowledgePackContextForScoring {
  active: boolean;
  keywords: string[];
  brandTerms: string[];
}

export interface VideoScoreItemContext {
  title: string;
  targetPlatform: string;
  script: VideoScriptAgentOutput | null;
  scenePlan: VideoScenePlannerAgentOutput | null;
  seo: {
    metaTitle: string | null;
    metaDescription: string | null;
    tags: unknown;
    chapters: unknown;
    hasSchemaMarkup: boolean;
  };
}

/**
 * Module 7 Phase 7.3 — the Video-specific analog of Module 6's
 * `ScoringInputBuilder`: "the ONE place app-specific shape knowledge
 * lives" for Video (that module's own doc comment). Deliberately NOT a
 * reuse/extension of `ScoringInputBuilder` — Video's authoritative
 * content lives in the `video_scripts` row + `metadata.videoPipeline`
 * PERSISTED, VALIDATED artifacts, never in `content_versions.body`
 * (which stays the Phase 7.1 create-time placeholder for a video
 * pipeline item, unlike Blog's real body). Reusing the generic Blog/
 * content-item builder would silently score the placeholder instead of
 * the real script.
 *
 * Every mapping below is into the SAME generic, frozen `ScoringInput`
 * shape (`@myev/shared`) VIDEO_DIMENSION_V1 / THUMBNAIL_DIMENSION_V1
 * consume — no shared contract is bent to fit Video; Video's own data
 * is mapped onto the closest honest generic slot, exactly as Blog's
 * builder already does for its own shape (e.g. Blog's H2/H3 outline →
 * generic `headings`).
 *
 * Only reads PERSISTED, VALIDATED pipeline state (`state.X.artifact`,
 * `video_scripts` columns) — never a raw, not-yet-finalized `ai_jobs`
 * row, and never an advisory stage (thumbnailConcepts feed the SEPARATE
 * Thumbnail input builder below; recommendations never feed scoring at
 * all — the frozen spec gives no basis for scoring advisory suggestions
 * as factual evidence). Pure function — never mutates pipeline state.
 */
@Injectable()
export class VideoScoringInputBuilder {
  /**
   * Builds the ScoringInput VIDEO_DIMENSION_V1 evaluates.
   *
   * `thumbnailEnrichment` (Phase 7.4) is passed ONLY when a REAL, FRESH
   * thumbnail image artifact exists — it carries the already-computed
   * Thumbnail Score + objective image facts so VIDEO_DIMENSION_V1's
   * "thumbnail quality" measure is a derived read, never a second pass.
   * Omitted for every Phase 7.1–7.3 item → identical output.
   */
  buildVideoInput(
    item: VideoScoreItemContext,
    kp: KnowledgePackContextForScoring,
    thumbnailEnrichment?: { currentThumbnailScore: number | null; imageEvidence?: { present: boolean; width: number; height: number; aspectRatioOk: boolean } },
  ): ScoringInput {
    const segments = item.script?.segments ?? [];
    const bodyText = segments.map((s) => s.narration).join("\n\n");
    const chapterTitles = this.extractChapterTitles(item.seo.chapters);
    const headings = [
      ...segments.map((s) => ({ level: 2, text: s.label })),
      ...chapterTitles.map((title) => ({ level: 3, text: title })),
    ];
    const assetRequirementCount = (item.scenePlan?.scenes ?? []).reduce((sum, scene) => sum + scene.assetRequirements.length, 0);
    const tags = this.extractStringArray(item.seo.tags);
    const targetKeywords = tags.length > 0 ? tags : kp.keywords;
    const primaryKeyword = tags[0] ?? kp.keywords[0];

    return {
      contentType: "VIDEO",
      title: item.title,
      bodyText,
      headings,
      mediaReferenceCount: assetRequirementCount,
      metadata: {
        ...(item.seo.metaTitle ? { metaTitle: item.seo.metaTitle } : {}),
        ...(item.seo.metaDescription ? { metaDescription: item.seo.metaDescription } : {}),
        ...(item.seo.hasSchemaMarkup ? { hasSchemaMarkup: true } : {}),
      },
      targetKeywords,
      ...(primaryKeyword ? { primaryKeyword } : {}),
      brandTerms: kp.brandTerms,
      knowledgePackActive: kp.active,
      targetPlatform: item.targetPlatform,
      ...(thumbnailEnrichment ? { currentThumbnailScore: thumbnailEnrichment.currentThumbnailScore } : {}),
      ...(thumbnailEnrichment?.imageEvidence ? { thumbnailImageEvidence: thumbnailEnrichment.imageEvidence } : {}),
    };
  }

  /**
   * Builds the ScoringInput THUMBNAIL_DIMENSION_V1 evaluates, from ONE
   * concept — the agent's first-listed (primary) proposal. Returns null
   * when no Thumbnail Concept artifact exists; the caller (VideoScoring
   * Service) must not run the Thumbnail dimension at all in that case —
   * "if Thumbnail Concepts do not exist, do not invent a Thumbnail
   * Score" (checkpoint §8) means never calling evaluate() with empty
   * input, not calling it and discarding a fabricated 0.
   */
  buildThumbnailInput(
    concepts: ThumbnailConceptAgentOutput | null,
    kp: KnowledgePackContextForScoring,
    imageEvidence?: { present: boolean; width: number; height: number; aspectRatioOk: boolean },
  ): ScoringInput | null {
    const concept = concepts?.concepts?.[0];
    if (!concept) return null;
    return {
      contentType: "VIDEO_THUMBNAIL_CONCEPT",
      title: concept.title,
      bodyText: `${concept.visualDirection}\n${concept.composition}`,
      metadata: {
        metaTitle: concept.overlayText,
        metaDescription: concept.ctrHypothesis,
      },
      targetKeywords: kp.keywords,
      ...(kp.keywords[0] ? { primaryKeyword: kp.keywords[0] } : {}),
      brandTerms: kp.brandTerms,
      knowledgePackActive: kp.active,
      ...(imageEvidence ? { thumbnailImageEvidence: imageEvidence } : {}),
    };
  }

  private extractChapterTitles(chapters: unknown): string[] {
    if (!Array.isArray(chapters)) return [];
    return chapters
      .map((c) => (c && typeof c === "object" && typeof (c as Record<string, unknown>).title === "string" ? ((c as Record<string, unknown>).title as string) : null))
      .filter((t): t is string => !!t);
  }

  private extractStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === "string");
  }
}

/** Pulls the VideoScoreItemContext out of the video_scripts row + the pipeline state — a thin adapter kept here, not in the service, so the mapping is unit-testable alongside the builder. */
export function toVideoScoreItemContext(
  title: string,
  script: { targetPlatform: string; metaTitle: string | null; metaDescription: string | null; tags: unknown; chapters: unknown; schemaMarkup: unknown },
  state: VideoPipelineState,
): VideoScoreItemContext {
  return {
    title,
    targetPlatform: script.targetPlatform,
    script: state.script.artifact,
    scenePlan: state.scenePlan.artifact,
    seo: {
      metaTitle: script.metaTitle,
      metaDescription: script.metaDescription,
      tags: script.tags,
      chapters: script.chapters,
      hasSchemaMarkup: !!script.schemaMarkup,
    },
  };
}
