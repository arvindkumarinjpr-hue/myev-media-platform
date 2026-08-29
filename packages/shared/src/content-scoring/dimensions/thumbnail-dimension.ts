import type { ContentDimension, DimensionEvaluation } from "../content-dimension";
import type { ImprovementRecommendation } from "../improvement-recommendation";
import type { ScoringFactor } from "../scoring-factor";
import type { ScoringInput } from "../scoring-input";
import { roundScore } from "../score-bounds";
import { weightedFactorMean } from "../scoring-factor";
import { bandScore, containsPhrase, phraseCoverage, rampScore, wordCount } from "../text-analysis";

/**
 * Module 7 Phase 7.3 — THUMBNAIL_DIMENSION_V1.
 *
 * `appliesTo: ["VIDEO_THUMBNAIL_CONCEPT"]` — DELIBERATELY NOT `"VIDEO"`.
 * `ContentDimensionRegistry.resolveForContentType` throws "ambiguous"
 * when more than one registered dimension claims the same ContentType,
 * and VIDEO_DIMENSION_V1 already owns `"VIDEO"` (the ONE dimension the
 * generic scoring endpoint / Blog-style pipeline scoring resolves for a
 * VIDEO content item — unchanged Module 6 resolution semantics). This
 * dimension is never meant to be found that way: `VideoScoringService`
 * resolves it directly by name (`registry.resolve("thumbnail", 1)`) as
 * a SECOND, independent scoring pass, run only when a Thumbnail Concept
 * artifact actually exists. `"VIDEO_THUMBNAIL_CONCEPT"` is a stable,
 * self-documenting logical identifier — no `content_items.content_type`
 * row value is ever literally this string, so `resolveForContentType`
 * can never accidentally return this dimension for a real ContentType,
 * and no other dimension resolution is ever ambiguous because of it.
 *
 * CONTENT_SCORING_ENGINE_V1.0.md §6 "Thumbnail Score" measures: Visual
 * clarity · Text readability · CTR potential · Brand consistency.
 *
 * Phase 7.3 only has a TEXT Thumbnail Concept artifact (title, visual
 * direction, overlay text, composition, CTR hypothesis) — no rendered
 * image exists yet (Phase 7.4). Every factor below is scored ONLY from
 * that structured text; NONE of them evaluate actual image contrast,
 * facial expression, pixel composition, rendered-resolution readability,
 * or generated-image quality — the "Visual clarity" factor explicitly
 * says so in its own `reason`. Phase 7.4 can enrich the SAME dimension
 * (bump `version`, add real image-derived factors) once rendered
 * thumbnail assets exist — this file's shape does not need to change to
 * do that, and no second Thumbnail scoring engine is ever created.
 */

const CTR_HOOK_WORDS = ["shocked", "never", "secret", "mistake", "actually", "before you", "won't believe", "warning", "truth"];

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

export const THUMBNAIL_DIMENSION_V1: ContentDimension = {
  name: "thumbnail",
  version: 1,
  appliesTo: ["VIDEO_THUMBNAIL_CONCEPT"],
  dimensionScoreLabel: "Thumbnail Score",
  purpose: "Deterministic, TEXT-ONLY structural analysis of a Thumbnail Concept artifact (no rendered image exists in Phase 7.3) for the five universal score categories plus a Thumbnail Score.",

  evaluate(input: ScoringInput): DimensionEvaluation {
    // VideoScoringInputBuilder maps ONE ThumbnailConcept (the agent's
    // first-listed / primary concept) into this ScoringInput:
    //   title           -> concept.title
    //   bodyText        -> `${visualDirection}\n${composition}`
    //   metadata.metaTitle -> concept.overlayText (short, punchy — the
    //                         closest generic slot to an overlay caption)
    //   metadata.metaDescription -> concept.ctrHypothesis
    const conceptTitle = input.title;
    const visualAndComposition = input.bodyText ?? "";
    const overlayText = input.metadata?.metaTitle ?? "";
    const ctrHypothesis = input.metadata?.metaDescription ?? "";
    const brandTerms = input.brandTerms ?? [];
    const recs: ImprovementRecommendation[] = [];

    const hasConcept = conceptTitle.trim().length > 0 || visualAndComposition.trim().length > 0;

    // ---------- Visual clarity (proxy: description specificity — NOT real pixels) ----------
    const descWords = wordCount(visualAndComposition);
    const visualClarityValue = !hasConcept ? 0 : bandScore(descWords, { min: 2, idealLow: 8, idealHigh: 40, max: 100, floorScore: 20 });
    const qualityVisualClarity = mk(
      "quality-thumbnail-visual-clarity",
      "QUALITY",
      "Visual-direction clarity (described concept only)",
      visualClarityValue,
      2,
      !hasConcept
        ? "No Thumbnail Concept generated yet."
        : `Visual direction + composition guidance is ${descWords} words — specific enough to brief a designer. This does NOT assess an actual rendered image (none exists yet).`,
      { descriptionWords: descWords },
    );
    if (!hasConcept) recs.push({ id: "rec-generate-thumbnail-concept", priority: "MEDIUM", category: "QUALITY", message: "Generate Thumbnail Concepts before scoring the thumbnail.", relatedFactorId: qualityVisualClarity.id });

    // ---------- Text readability (overlay text length) ----------
    const overlayLen = overlayText.trim().length;
    const readabilityValue = overlayLen === 0 ? 0 : bandScore(overlayLen, { min: 1, idealLow: 4, idealHigh: 25, max: 40, floorScore: 20 });
    const engagementReadability = mk(
      "engagement-thumbnail-text-readability",
      "ENGAGEMENT",
      "Overlay text readability",
      readabilityValue,
      2,
      overlayLen === 0 ? "No overlay text proposed yet." : `Overlay text is ${overlayLen} characters — short overlay text stays legible at thumbnail size.`,
      { overlayTextLength: overlayLen },
    );
    if (overlayLen > 30) recs.push({ id: "rec-shorten-overlay", priority: "MEDIUM", category: "ENGAGEMENT", message: "Shorten the overlay text — long text is illegible at thumbnail size.", relatedFactorId: engagementReadability.id });

    // ---------- CTR potential (hypothesis quality proxy — text only) ----------
    const hypothesisWords = wordCount(ctrHypothesis);
    const hookWordHits = CTR_HOOK_WORDS.filter((w) => containsPhrase(`${overlayText} ${ctrHypothesis}`, w)).length;
    const ctrValue = hypothesisWords === 0 ? 0 : Math.round((bandScore(hypothesisWords, { min: 2, idealLow: 8, idealHigh: 30, max: 60, floorScore: 25 }) + rampScore(hookWordHits, 0, 1)) / 2);
    const viralCtrPotential = mk(
      "viral-thumbnail-ctr-potential",
      "VIRAL",
      "CTR hypothesis strength",
      ctrValue,
      2,
      hypothesisWords === 0 ? "No CTR hypothesis provided yet." : `CTR hypothesis is ${hypothesisWords} words${hookWordHits > 0 ? " and names a concrete curiosity/urgency driver" : ""}.`,
      { hypothesisWords, hookWords: hookWordHits },
    );

    // ---------- Brand consistency ----------
    const brandHits = brandTerms.length === 0 ? 0 : phraseCoverage(`${conceptTitle} ${visualAndComposition} ${overlayText}`, brandTerms);
    const businessBrandConsistency = mk(
      "business-thumbnail-brand-consistency",
      "BUSINESS",
      "Brand consistency",
      brandTerms.length === 0 ? 45 : rampScore(brandHits, 0, Math.max(1, Math.ceil(brandTerms.length / 2))),
      1.5,
      brandTerms.length === 0
        ? input.knowledgePackActive
          ? "No brand terms configured in the active Knowledge Pack's brand guidelines."
          : "No active Knowledge Pack — brand alignment could not be assessed."
        : `${brandHits} of ${brandTerms.length} brand term(s) referenced in the concept.`,
      { brandTerms: brandTerms.length, matched: brandHits },
    );

    // ---------- SEO (weakest link for a thumbnail — kept honest and thin) ----------
    const keywords = input.targetKeywords ?? [];
    const primary = input.primaryKeyword ?? keywords[0] ?? "";
    const primaryInConcept = primary !== "" && containsPhrase(`${conceptTitle} ${overlayText}`, primary);
    const seoConceptRelevance = mk(
      "seo-thumbnail-concept-relevance",
      "SEO",
      "Concept relevance to target keyword",
      primary === "" ? 40 : primaryInConcept ? 100 : 30,
      1,
      primary === "" ? "No target keywords/tags available to check the concept against." : primaryInConcept ? `Concept references "${primary}".` : `Concept does not reference "${primary}" — this is a minor signal for a thumbnail.`,
      { primaryKeyword: primary || "(none)" },
    );

    const categoryFactors: ScoringFactor[] = [qualityVisualClarity, engagementReadability, viralCtrPotential, businessBrandConsistency, seoConceptRelevance];

    // ---------- Thumbnail Score (own dimension score) ----------
    // CONTENT_SCORING_ENGINE_V1.0.md §6: Visual clarity · Text
    // readability · CTR potential · Brand consistency.
    const dimVisualClarity = mk("thumbnail-visual-clarity", null, "Visual clarity (described concept only)", visualClarityValue, 2, "Same measurement as the QUALITY category's visual-direction-clarity factor — a text description, not a rendered image.");
    const dimTextReadability = mk("thumbnail-text-readability", null, "Text readability", readabilityValue, 2, "Same measurement as the ENGAGEMENT category's overlay-readability factor.");
    const dimCtrPotential = mk("thumbnail-ctr-potential", null, "CTR potential", ctrValue, 2, "Same measurement as the VIRAL category's CTR-hypothesis-strength factor.");
    const dimBrandConsistency = mk("thumbnail-brand-consistency", null, "Brand consistency", businessBrandConsistency.value, 1.5, "Same measurement as the BUSINESS category's brand-consistency factor.");
    const dimensionFactors = [dimVisualClarity, dimTextReadability, dimCtrPotential, dimBrandConsistency];
    const dimensionScore = hasConcept ? roundScore(weightedFactorMean(dimensionFactors)) : 0;

    return { categoryFactors, dimensionScore, dimensionFactors, recommendations: recs };
  },
};
