import type { ContentDimension, DimensionEvaluation } from "../content-dimension";
import type { ImprovementRecommendation } from "../improvement-recommendation";
import type { ScoringFactor } from "../scoring-factor";
import type { ScoringInput } from "../scoring-input";
import { roundScore } from "../score-bounds";
import { weightedFactorMean } from "../scoring-factor";
import { averageWordsPerSentence, bandScore, containsPhrase, phraseCoverage, rampScore, wordCount } from "../text-analysis";

/**
 * Module 7 Phase 7.3 — VIDEO_DIMENSION_V1, the second registered
 * content-type scoring dimension (MODULE_ROADMAP_V1.0.md §11 / this
 * checkpoint's own Phase 7.3 task: "Module 7 extends the dimension
 * registry only").
 *
 * `appliesTo: ["VIDEO"]` — the ONE canonical dimension for the frozen
 * VIDEO ContentType, resolved by `ContentDimensionRegistry.
 * resolveForContentType("VIDEO")` exactly like BLOG_DIMENSION_V1 is for
 * BLOG. (THUMBNAIL_DIMENSION_V1 is registered separately and is
 * deliberately NOT resolvable this way — see its own file comment — so
 * this resolution stays unambiguous.)
 *
 * CONTENT_SCORING_ENGINE_V1.0.md §4 "Video Score" measures: Hook
 * strength · Script quality · Retention potential · Thumbnail quality ·
 * CTA effectiveness — these become the 5 `dimensionFactors` below.
 * "Thumbnail quality" here is a COARSE presence/readiness signal only
 * (does a concept exist, is its overlay text usable) — the DEEP
 * visual-clarity/CTR/brand analysis is THUMBNAIL_DIMENSION_V1's own job.
 *
 * Purely DETERMINISTIC, same discipline as BLOG_DIMENSION_V1: every
 * factor is computed by structural analysis of the normalized
 * ScoringInput the API-layer VideoScoringInputBuilder produces from
 * PERSISTED, VALIDATED pipeline artifacts only (brief/script/scenePlan/
 * SEO) — never from raw unvalidated provider output, never from
 * advisory Recommendations, never fabricating evidence for a stage that
 * has not run yet (Assets/Voice/Render/QA are Phase 7.4/7.5 — their
 * absence shows up here as low/neutral factors with an honest reason,
 * never as a fake "passed").
 */

const HOOK_PHRASES = ["imagine", "did you know", "what if", "here's why", "the truth about", "stop", "you're doing it wrong", "nobody tells you"];
const CTA_PHRASES = ["subscribe", "book a", "sign up", "get started", "learn more", "try it free", "download", "comment", "share this", "follow for"];

// Loose per-platform expectations, derived only from the frozen
// "Supported Outputs" (VIDEO_AUTOMATION_ENGINE_V1.0.md): short vertical
// formats want a tight script; everything else has more room. Not a
// frozen numeric spec — a documented, reviewable default, same status as
// BLOG_DIMENSION_V1's own word-count bands.
const SHORT_PLATFORMS = new Set(["YOUTUBE_SHORTS", "INSTAGRAM_REEL", "FACEBOOK_REEL"]);

function mk(
  id: string,
  category: ScoringFactor["category"],
  label: string,
  value: number,
  weight: number,
  reason: string,
  evidence?: ScoringFactor["evidence"],
): ScoringFactor {
  return { id, category, label, value: roundScore(value), weight, reason, ...(evidence ? { evidence } : {}) };
}

export const VIDEO_DIMENSION_V1: ContentDimension = {
  name: "video",
  version: 1,
  appliesTo: ["VIDEO"],
  dimensionScoreLabel: "Video Score",
  purpose: "Deterministic structural analysis of a video's brief/script/scene-plan/SEO artifacts for the five universal score categories plus a Video Score (hook, script quality, retention, thumbnail readiness, CTA).",

  evaluate(input: ScoringInput): DimensionEvaluation {
    const body = input.bodyText ?? ""; // concatenated script segment narrations (VideoScoringInputBuilder)
    const words = wordCount(body);
    const headings = input.headings ?? [];
    const segments = headings.filter((h) => h.level === 2); // one per script segment
    const chapters = headings.filter((h) => h.level === 3); // one per SEO chapter
    const keywords = input.targetKeywords ?? [];
    const primary = input.primaryKeyword ?? keywords[0] ?? "";
    const meta = input.metadata ?? {};
    const assetRequirementCount = input.mediaReferenceCount ?? 0; // total scene-plan asset requirements
    const brandTerms = input.brandTerms ?? [];
    const isShortForm = input.targetPlatform !== undefined && SHORT_PLATFORMS.has(input.targetPlatform);
    const recs: ImprovementRecommendation[] = [];

    const hookText = body.split(/\n\s*\n/)[0]?.trim() ?? "";
    const hookWords = wordCount(hookText);

    // ---------- SEO ----------
    const primaryInTitle = primary !== "" && containsPhrase(input.title, primary);
    const seoTitleKeyword = mk(
      "seo-primary-keyword-in-title",
      "SEO",
      "Primary keyword/tag in title",
      primary === "" ? 30 : primaryInTitle ? 100 : 0,
      2,
      primary === "" ? "No target keywords/tags available to check the title against." : primaryInTitle ? `Title contains "${primary}".` : `Title does not contain "${primary}".`,
      { primaryKeyword: primary || "(none)" },
    );
    if (primary !== "" && !primaryInTitle) {
      recs.push({ id: "rec-keyword-in-title", priority: "HIGH", category: "SEO", message: `Include "${primary}" in the video title.`, relatedFactorId: seoTitleKeyword.id });
    }

    const metaTitleOk = (meta.metaTitle ?? "").length >= 15 && (meta.metaTitle ?? "").length <= 100;
    const metaDescOk = (meta.metaDescription ?? "").length >= 50 && (meta.metaDescription ?? "").length <= 5000;
    const tagsOk = keywords.length >= 3;
    const metaComplete = [metaTitleOk, metaDescOk, tagsOk, !!meta.hasSchemaMarkup].filter(Boolean).length;
    const seoMetadata = mk(
      "seo-metadata-completeness",
      "SEO",
      "Video SEO metadata completeness",
      rampScore(metaComplete, 0, 4),
      1.5,
      `${metaComplete} of 4 SEO elements present (meta title, meta description, ≥3 tags, VideoObject schema).`,
      { metaTitle: metaTitleOk, metaDescription: metaDescOk, tags: tagsOk, schemaMarkup: !!meta.hasSchemaMarkup },
    );
    if (!metaDescOk) recs.push({ id: "rec-meta-description", priority: "HIGH", category: "SEO", message: "Generate the video SEO metadata pass — no usable description yet.", relatedFactorId: seoMetadata.id });

    const seoChapters = mk(
      "seo-chapters-present",
      "SEO",
      "Chapter markers",
      rampScore(chapters.length, 0, 3),
      1,
      chapters.length === 0 ? "No chapter markers yet (SEO stage not complete, or the video is short enough not to need them)." : `${chapters.length} chapter marker(s) present.`,
      { chapters: chapters.length },
    );

    // ---------- VIRAL ----------
    const viralHookStrength = mk(
      "viral-hook-strength",
      "VIRAL",
      "Hook strength",
      hookWords === 0 ? 0 : bandScore(hookWords, { min: 1, idealLow: 6, idealHigh: 25, max: 60, floorScore: 20 }),
      2,
      hookWords === 0 ? "No script hook available yet." : `Hook is ${hookWords} word(s) (6–25 keeps it fast without feeling clipped).`,
      { hookWords },
    );
    if (hookWords === 0) recs.push({ id: "rec-generate-script", priority: "HIGH", category: "VIRAL", message: "Generate the script — no hook exists to evaluate yet.", relatedFactorId: viralHookStrength.id });

    const hookPhraseHits = HOOK_PHRASES.filter((p) => containsPhrase(hookText, p)).length;
    const viralHookDevice = mk(
      "viral-hook-device",
      "VIRAL",
      "Curiosity/pattern-interrupt device",
      hookText === "" ? 0 : rampScore(hookPhraseHits, 0, 1),
      1,
      hookPhraseHits === 0 ? "Hook does not use a recognisable curiosity/pattern-interrupt device." : "Hook uses a curiosity/pattern-interrupt device.",
      { device: hookPhraseHits > 0 },
    );

    const viralPlatformFit = mk(
      "viral-platform-fit",
      "VIRAL",
      "Length fit for target platform",
      words === 0
        ? 0
        : isShortForm
          ? bandScore(words, { min: 5, idealLow: 30, idealHigh: 150, max: 300, floorScore: 20 })
          : bandScore(words, { min: 30, idealLow: 300, idealHigh: 2200, max: 5000, floorScore: 25 }),
      1.5,
      words === 0
        ? "No script body to assess length against."
        : `Script is ${words} words for a ${isShortForm ? "short vertical" : "long-form"} target (${input.targetPlatform ?? "platform unset"}).`,
      { wordCount: words, targetPlatform: input.targetPlatform ?? "(unset)" },
    );

    // ---------- QUALITY ----------
    const qualitySegmentStructure = mk(
      "quality-segment-structure",
      "QUALITY",
      "Segment structure",
      bandScore(segments.length, { min: 0, idealLow: 3, idealHigh: 9, max: 20, floorScore: 15 }),
      2,
      `${segments.length} script segment(s).`,
      { segments: segments.length },
    );
    if (segments.length === 0) recs.push({ id: "rec-generate-script-2", priority: "HIGH", category: "QUALITY", message: "Generate the script — no segments to structure the video around.", relatedFactorId: qualitySegmentStructure.id });

    const awps = averageWordsPerSentence(body);
    const qualityPacing = mk(
      "quality-narration-pacing",
      "QUALITY",
      "Narration pacing (avg sentence length)",
      words === 0 ? 0 : bandScore(awps, { min: 3, idealLow: 6, idealHigh: 16, max: 35, floorScore: 25 }),
      1.5,
      words === 0 ? "No narration to assess pacing." : `Average sentence is ${awps.toFixed(1)} words (6–16 reads well aloud on camera).`,
      { avgWordsPerSentence: Number(awps.toFixed(1)) },
    );

    const qualitySceneCoverage = mk(
      "quality-scene-asset-coverage",
      "QUALITY",
      "Scene-plan asset coverage",
      segments.length === 0 ? 0 : rampScore(assetRequirementCount, 0, Math.max(1, segments.length)),
      1.5,
      segments.length === 0
        ? "No script to plan scenes against yet."
        : assetRequirementCount === 0
          ? "No scene plan yet — asset requirements are not yet itemized."
          : `${assetRequirementCount} itemized asset requirement(s) across the scene plan.`,
      { assetRequirements: assetRequirementCount },
    );
    if (segments.length > 0 && assetRequirementCount === 0) {
      recs.push({ id: "rec-generate-scene-plan", priority: "MEDIUM", category: "QUALITY", message: "Generate the scene plan so every segment has itemized visual/asset requirements.", relatedFactorId: qualitySceneCoverage.id });
    }

    // ---------- ENGAGEMENT ----------
    const ctaHits = CTA_PHRASES.filter((p) => containsPhrase(body, p)).length;
    const engagementCta = mk(
      "engagement-cta-presence",
      "ENGAGEMENT",
      "Call-to-action presence",
      body === "" ? 0 : ctaHits === 0 ? 10 : rampScore(ctaHits, 0, 2),
      2,
      body === "" ? "No script to check for a CTA." : ctaHits === 0 ? "No recognisable call-to-action phrase in the narration." : `${ctaHits} call-to-action phrase(s) present.`,
      { ctaPhrases: ctaHits },
    );
    if (body !== "" && ctaHits === 0) recs.push({ id: "rec-add-cta", priority: "HIGH", category: "ENGAGEMENT", message: "Add a clear spoken call-to-action to the script's closing segment.", relatedFactorId: engagementCta.id });

    const avgSegmentWords = segments.length === 0 ? 0 : words / segments.length;
    const engagementRetention = mk(
      "engagement-retention-pacing",
      "ENGAGEMENT",
      "Retention-oriented segment pacing",
      segments.length === 0 ? 0 : bandScore(avgSegmentWords, { min: 3, idealLow: 15, idealHigh: 60, max: 200, floorScore: 20 }),
      1.5,
      segments.length === 0 ? "No segments to assess pacing against." : `Average segment is ${avgSegmentWords.toFixed(0)} words — short, punchy beats hold attention better than long unbroken ones.`,
      { avgSegmentWords: Math.round(avgSegmentWords) },
    );

    // ---------- BUSINESS ----------
    const brandHits = brandTerms.length === 0 ? 0 : phraseCoverage(`${input.title} ${body}`, brandTerms);
    const businessBrand = mk(
      "business-brand-presence",
      "BUSINESS",
      "Brand presence",
      brandTerms.length === 0 ? 45 : rampScore(brandHits, 0, Math.max(1, Math.ceil(brandTerms.length / 2))),
      1.5,
      brandTerms.length === 0
        ? input.knowledgePackActive
          ? "No brand terms configured in the active Knowledge Pack's brand guidelines."
          : "No active Knowledge Pack — brand alignment could not be assessed."
        : `${brandHits} of ${brandTerms.length} brand term(s) referenced.`,
      { brandTerms: brandTerms.length, matched: brandHits },
    );
    if (!input.knowledgePackActive) {
      recs.push({ id: "rec-activate-knowledge-pack", priority: "LOW", category: "BUSINESS", message: "Activate a Knowledge Pack so keyword and brand alignment can be scored fully." });
    }

    const businessCtaObjective = mk(
      "business-cta-objective-alignment",
      "BUSINESS",
      "CTA / business-objective alignment",
      body === "" ? 0 : ctaHits === 0 ? 15 : rampScore(ctaHits, 0, 2),
      2,
      body === "" ? "No script to assess business alignment." : ctaHits === 0 ? "The script has no CTA driving toward a business objective yet." : "The script's CTA gives the viewer a concrete next step.",
      { ctaPhrases: ctaHits },
    );

    const categoryFactors: ScoringFactor[] = [
      seoTitleKeyword,
      seoMetadata,
      seoChapters,
      viralHookStrength,
      viralHookDevice,
      viralPlatformFit,
      qualitySegmentStructure,
      qualityPacing,
      qualitySceneCoverage,
      engagementCta,
      engagementRetention,
      businessBrand,
      businessCtaObjective,
    ];

    // ---------- Video Score (own dimension score) ----------
    // CONTENT_SCORING_ENGINE_V1.0.md §4: Hook strength · Script quality ·
    // Retention potential · Thumbnail quality · CTA effectiveness.
    const dimHookStrength = mk("video-hook-strength", null, "Hook strength", viralHookStrength.value, 2, "Same measurement as the VIRAL category's hook-strength factor.");
    const dimScriptQuality = mk(
      "video-script-quality",
      null,
      "Script quality",
      roundScore(weightedFactorMean([qualitySegmentStructure, qualityPacing])),
      2,
      "Derived from segment structure and narration pacing.",
    );
    const dimRetentionPotential = mk("video-retention-potential", null, "Retention potential", engagementRetention.value, 1.5, "Same measurement as the ENGAGEMENT category's retention-pacing factor.");
    // NEUTRAL, fixed value — deliberately NOT computed from anything: this
    // dimension's ScoringInput carries no thumbnail-concept evidence at
    // all (VideoScoringInputBuilder builds a SEPARATE ScoringInput for
    // THUMBNAIL_DIMENSION_V1, which is the authoritative deep analysis —
    // see that file). Never fabricated, never silently borrowing another
    // dimension's number.
    const dimThumbnailQuality = mk(
      "video-thumbnail-quality",
      null,
      "Thumbnail quality (see separate Thumbnail Score)",
      50,
      1,
      "Not evaluated by the Video dimension — no thumbnail-concept evidence is passed to it. See the separate Thumbnail Score, produced once a Thumbnail Concept artifact exists.",
    );
    const dimCtaEffectiveness = mk("video-cta-effectiveness", null, "CTA effectiveness", businessCtaObjective.value, 1.5, "Same measurement as the BUSINESS category's CTA-alignment factor.");
    const dimensionFactors = [dimHookStrength, dimScriptQuality, dimRetentionPotential, dimThumbnailQuality, dimCtaEffectiveness];
    const dimensionScore = roundScore(weightedFactorMean(dimensionFactors));

    return { categoryFactors, dimensionScore, dimensionFactors, recommendations: recs };
  },
};
