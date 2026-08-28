/**
 * Module 6 Phase 6.3 — Blog Pipeline orchestration state.
 *
 * The pipeline's per-item progress is persisted in the EXISTING generic
 * `content_items.metadata` JSON bag under the `blogPipeline` key — Module
 * 1E deliberately provides this "generic, type-agnostic bag" precisely so
 * type-specific orchestration state does not need its own table. No
 * brief/outline/pipeline-state tables are introduced (an explicit Phase
 * 6.3 boundary). The draft itself is persisted as a real
 * `content_versions` row; the SEO metadata as a real `blog_articles` row;
 * every score as an append-only `content_scores` row (Phase 6.1). Only
 * the orchestration bookkeeping — which stage, which AI job, whether an
 * artifact was approved — lives here.
 */

import type {
  BlogBriefAgentOutput,
  BlogDraftAgentOutput,
  BlogOutlineAgentOutput,
  SeoMetadataAgentOutput,
} from "@myev/shared";

export const BLOG_PIPELINE_METADATA_KEY = "blogPipeline" as const;

/** A generation stage backed by an AI job (brief / outline / draft / seo). */
export type GenerationStageStatus = "PENDING" | "GENERATING" | "READY" | "APPROVED" | "FAILED";

/** A deterministic stage with no AI job of its own (internal-linking / qa / scoring). */
export type DeterministicStageStatus = "PENDING" | "COMPLETED";

export interface BriefStageState {
  status: GenerationStageStatus;
  /** publicId of the most recent ai_jobs row for this stage — history is never destroyed. */
  aiJobPublicId: string | null;
  /** The validated BlogBriefAgentOutput, present once status is READY or APPROVED. */
  artifact: BlogBriefAgentOutput | null;
  approvedAt: string | null;
  approvedByUserPublicId: string | null;
  failureReason: string | null;
}

export interface OutlineStageState {
  status: GenerationStageStatus;
  aiJobPublicId: string | null;
  artifact: BlogOutlineAgentOutput | null;
  approvedAt: string | null;
  approvedByUserPublicId: string | null;
  failureReason: string | null;
}

export interface DraftStageState {
  status: GenerationStageStatus;
  aiJobPublicId: string | null;
  /** The content_versions row this generated draft was persisted as. */
  contentVersionPublicId: string | null;
  /** The structured draft, kept for the read model alongside the rendered version body. */
  artifact: BlogDraftAgentOutput | null;
  failureReason: string | null;
}

export interface SeoStageState {
  status: GenerationStageStatus;
  aiJobPublicId: string | null;
  /** The blog_articles row this SEO pass wrote. */
  blogArticlePublicId: string | null;
  artifact: SeoMetadataAgentOutput | null;
  failureReason: string | null;
}

export interface InternalLinkingSuggestion {
  targetContentItemPublicId: string;
  anchorText: string;
  reason: string;
}

export interface InternalLinkingStageState {
  status: DeterministicStageStatus;
  /** FR-BLOG-005: "No related content found → pass completes with zero suggestions, not an error." */
  suggestions: InternalLinkingSuggestion[];
  /**
   * A typed internal status. Module 8 (the real Internal Linking Engine)
   * is not built in Phase 6.3 — the stage/seam exists and legitimately
   * returns zero suggestions with this reason until Module 8 lands.
   */
  reason: "engine_not_available" | "no_related_content_found" | "suggestions_generated";
  completedAt: string | null;
}

export interface QaCheckResult {
  id: "grammar" | "readability" | "duplicate_content" | "structure_headings" | "keyword_stuffing" | "brand_compliance";
  label: string;
  passed: boolean;
  explanation: string;
  evidence: string[];
}

export interface QaStageState {
  status: DeterministicStageStatus;
  checks: QaCheckResult[];
  completedAt: string | null;
}

export interface ScoringStageState {
  status: DeterministicStageStatus;
  /** Append-only content_scores row publicId — Phase 6.1 owns the math and persistence. */
  contentScorePublicId: string | null;
  overallScore: number | null;
  passThreshold: number | null;
  passed: boolean | null;
  ranAt: string | null;
}

export interface BlogPipelineState {
  /** The EXACT Knowledge Pack version publicId this pipeline is bound to, locked at create time (ADR-004 non-substitution). */
  knowledgePackVersionId: string;
  brief: BriefStageState;
  outline: OutlineStageState;
  draft: DraftStageState;
  seo: SeoStageState;
  internalLinking: InternalLinkingStageState;
  qa: QaStageState;
  scoring: ScoringStageState;
}

/** Coarse read-model label for "where is this article in the pipeline right now". Derived, never stored as the source of truth. */
export type BlogPipelineStage =
  | "BRIEF"
  | "OUTLINE"
  | "DRAFT"
  | "SEO"
  | "INTERNAL_LINKING"
  | "QA"
  | "SCORING"
  | "READY_FOR_REVIEW"
  | "IN_REVIEW"
  | "APPROVED"
  | "PUBLISH_READY";
