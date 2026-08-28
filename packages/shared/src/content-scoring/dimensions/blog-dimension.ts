import type { ContentDimension, DimensionEvaluation } from "../content-dimension";
import type { ImprovementRecommendation } from "../improvement-recommendation";
import type { ScoringFactor } from "../scoring-factor";
import type { ScoringInput } from "../scoring-input";
import { roundScore } from "../score-bounds";
import { weightedFactorMean } from "../scoring-factor";
import {
  averageWordsPerSentence,
  bandScore,
  containsPhrase,
  phraseCoverage,
  phraseOccurrences,
  rampScore,
  wordCount,
} from "../text-analysis";

/**
 * Module 6 Phase 6.1 — the FIRST registered content-type scoring
 * dimension (MODULE_ROADMAP_V1.0.md §11: "the shared engine gets its
 * first real, end-to-end proof" against Blog).
 *
 * Purely DETERMINISTIC (task rule 6 / CONTENT_SCORING_ENGINE_V1.0.md's
 * "Explainable Scores"): every factor is computed by structural analysis
 * of the normalized ScoringInput — headings, word/sentence counts,
 * keyword presence, metadata completeness, link counts. No AI provider
 * call. No randomness. Same input → identical output.
 *
 * Contributes ≥ 1 factor to each of the five universal categories (the
 * composite formula needs all five) and produces its own "Blog Score"
 * covering CONTENT_SCORING_ENGINE_V1.0.md §5's listed measures — topic
 * depth, search-intent alignment, authority, FAQ coverage, formatting.
 *
 * This file uses ONLY the public `@myev/shared` content-scoring contract.
 * Module 7 adds Video/Thumbnail dimensions the same way and never edits
 * this file (§11 Module 7 gate).
 */

const CTA_PHRASES = [
  "sign up",
  "subscribe",
  "get started",
  "learn more",
  "contact us",
  "book a demo",
  "download",
  "try it free",
  "read more",
  "get in touch",
];

const POWER_WORDS = [
  "ultimate",
  "essential",
  "proven",
  "complete",
  "guide",
  "best",
  "how to",
  "why",
  "what",
  "top",
  "checklist",
  "step-by-step",
];

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

export const BLOG_DIMENSION_V1: ContentDimension = {
  name: "blog",
  version: 1,
  appliesTo: ["BLOG"],
  dimensionScoreLabel: "Blog Score",
  purpose: "Deterministic structural analysis of a blog article for the five universal score categories plus a Blog Score.",

  evaluate(input: ScoringInput): DimensionEvaluation {
    const body = input.bodyText ?? "";
    const words = wordCount(body);
    const headings = input.headings ?? [];
    const h2plus = headings.filter((h) => h.level >= 2);
    const keywords = input.targetKeywords ?? [];
    const primary = input.primaryKeyword ?? keywords[0] ?? "";
    const meta = input.metadata ?? {};
    const faqCount = input.faqQuestions?.length ?? 0;
    const internalLinks = input.internalLinkCount ?? 0;
    const externalLinks = input.externalLinkCount ?? 0;
    const mediaRefs = input.mediaReferenceCount ?? 0;
    const brandTerms = input.brandTerms ?? [];
    const recs: ImprovementRecommendation[] = [];

    // ---------- SEO ----------
    const primaryInTitle = primary !== "" && containsPhrase(input.title, primary);
    const seoTitleKeyword = mk(
      "seo-primary-keyword-in-title",
      "SEO",
      "Primary keyword in title",
      primary === "" ? 30 : primaryInTitle ? 100 : 0,
      2,
      primary === ""
        ? "No target keywords available to check the title against."
        : primaryInTitle
          ? `Title contains the primary keyword "${primary}".`
          : `Title does not contain the primary keyword "${primary}".`,
      { primaryKeyword: primary || "(none)" },
    );
    if (primary !== "" && !primaryInTitle) {
      recs.push({ id: "rec-keyword-in-title", priority: "HIGH", category: "SEO", message: `Include the primary keyword "${primary}" in the title.`, relatedFactorId: seoTitleKeyword.id });
    }

    const kwHits = keywords.filter((k) => phraseCoverage(body, [k]) > 0).length;
    const kwCoverageValue = keywords.length === 0 ? 40 : rampScore(kwHits / keywords.length, 0, 0.8);
    const seoKeywordCoverage = mk(
      "seo-keyword-coverage",
      "SEO",
      "Target keyword coverage in body",
      kwCoverageValue,
      2,
      keywords.length === 0
        ? "No target keywords available — supply an active Knowledge Pack keyword set for a full check."
        : `${kwHits} of ${keywords.length} target keyword(s) appear in the body.`,
      { targetKeywords: keywords.length, matched: kwHits },
    );
    if (keywords.length > 0 && kwHits < keywords.length) {
      recs.push({ id: "rec-keyword-coverage", priority: "MEDIUM", category: "SEO", message: `Work the remaining ${keywords.length - kwHits} target keyword(s) into the body naturally.`, relatedFactorId: seoKeywordCoverage.id });
    }

    const metaTitleOk = (meta.metaTitle ?? "").length >= 15 && (meta.metaTitle ?? "").length <= 60;
    const metaDescOk = (meta.metaDescription ?? "").length >= 70 && (meta.metaDescription ?? "").length <= 160;
    const slugOk = !!meta.urlSlug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.urlSlug);
    const metaComplete = [metaTitleOk, metaDescOk, slugOk, !!meta.hasSchemaMarkup].filter(Boolean).length;
    const seoMetadata = mk(
      "seo-metadata-completeness",
      "SEO",
      "SEO metadata completeness",
      rampScore(metaComplete, 0, 4),
      1.5,
      `${metaComplete} of 4 SEO metadata elements present and well-formed (meta title, meta description, URL slug, schema markup).`,
      { metaTitle: metaTitleOk, metaDescription: metaDescOk, urlSlug: slugOk, schemaMarkup: !!meta.hasSchemaMarkup },
    );
    if (!metaDescOk) recs.push({ id: "rec-meta-description", priority: "HIGH", category: "SEO", message: "Add a meta description of roughly 140–160 characters.", relatedFactorId: seoMetadata.id });
    if (!metaTitleOk) recs.push({ id: "rec-meta-title", priority: "MEDIUM", category: "SEO", message: "Set a meta title of 15–60 characters.", relatedFactorId: seoMetadata.id });
    if (!slugOk) recs.push({ id: "rec-url-slug", priority: "MEDIUM", category: "SEO", message: "Set a lowercase, hyphenated URL slug.", relatedFactorId: seoMetadata.id });

    const hasSingleH1 = headings.filter((h) => h.level === 1).length <= 1;
    const noSkippedLevels = headingsWellNested(headings);
    const seoHeadingStructure = mk(
      "seo-heading-structure",
      "SEO",
      "Heading hierarchy",
      hasSingleH1 && noSkippedLevels ? 100 : hasSingleH1 || noSkippedLevels ? 55 : 20,
      1,
      `${headings.length} heading(s); ${hasSingleH1 ? "at most one H1" : "multiple H1s"}, ${noSkippedLevels ? "no skipped levels" : "levels are skipped"}.`,
      { headingCount: headings.length },
    );

    // ---------- VIRAL ----------
    const titleLen = input.title.length;
    const viralTitleStrength = mk(
      "viral-title-strength",
      "VIRAL",
      "Headline strength",
      bandScore(titleLen, { min: 10, idealLow: 40, idealHigh: 65, max: 110, floorScore: 20 }),
      2,
      `Title is ${titleLen} characters (40–65 is the shareable sweet spot).`,
      { titleLength: titleLen },
    );
    if (titleLen < 30 || titleLen > 70) {
      recs.push({ id: "rec-title-length", priority: "MEDIUM", category: "VIRAL", message: "Aim for a 40–65 character headline.", relatedFactorId: viralTitleStrength.id });
    }

    const powerHits = POWER_WORDS.filter((w) => containsPhrase(input.title, w)).length;
    const viralHook = mk(
      "viral-headline-hook",
      "VIRAL",
      "Headline hook words",
      rampScore(powerHits, 0, 2),
      1,
      powerHits === 0 ? "Headline has no hook/curiosity words (how, why, best, guide, …)." : `Headline uses ${powerHits} hook word(s).`,
      { hookWords: powerHits },
    );
    if (powerHits === 0) recs.push({ id: "rec-headline-hook", priority: "LOW", category: "VIRAL", message: "Add a curiosity or value word to the headline (e.g. \"how\", \"guide\", \"proven\").", relatedFactorId: viralHook.id });

    const introText = firstParagraph(body);
    const viralOpening = mk(
      "viral-opening-strength",
      "VIRAL",
      "Opening strength",
      bandScore(wordCount(introText), { min: 0, idealLow: 25, idealHigh: 90, max: 200, floorScore: 15 }),
      1.5,
      `Opening passage is ${wordCount(introText)} words (25–90 keeps a reader moving).`,
    );

    // ---------- QUALITY ----------
    const qualityDepth = mk(
      "quality-content-depth",
      "QUALITY",
      "Content depth",
      bandScore(words, { min: 150, idealLow: 900, idealHigh: 2500, max: 6000, floorScore: 20 }),
      2,
      `Article is ${words} words (≈900–2500 is a strong depth range for most blog topics).`,
      { wordCount: words },
    );
    if (words < 600) recs.push({ id: "rec-content-depth", priority: "HIGH", category: "QUALITY", message: "Expand the article — under ~600 words rarely covers a topic with authority.", relatedFactorId: qualityDepth.id });

    const awps = averageWordsPerSentence(body);
    const qualityReadability = mk(
      "quality-readability",
      "QUALITY",
      "Readability (avg sentence length)",
      bandScore(awps, { min: 5, idealLow: 12, idealHigh: 20, max: 40, floorScore: 25 }),
      1.5,
      words === 0 ? "No body text to assess readability." : `Average sentence is ${awps.toFixed(1)} words (12–20 reads smoothly).`,
      { avgWordsPerSentence: Number(awps.toFixed(1)) },
    );
    if (words > 0 && awps > 24) recs.push({ id: "rec-readability", priority: "MEDIUM", category: "QUALITY", message: "Shorten sentences — the average is long enough to slow readers down.", relatedFactorId: qualityReadability.id });

    const qualityStructure = mk(
      "quality-structure",
      "QUALITY",
      "Section structure",
      bandScore(h2plus.length, { min: 0, idealLow: 3, idealHigh: 12, max: 30, floorScore: 15 }),
      1,
      `${h2plus.length} H2+ section heading(s).`,
      { sectionHeadings: h2plus.length },
    );
    if (h2plus.length < 2) recs.push({ id: "rec-add-sections", priority: "MEDIUM", category: "QUALITY", message: "Break the article into clearly-headed sections (H2/H3).", relatedFactorId: qualityStructure.id });

    // ---------- ENGAGEMENT ----------
    const engagementFaq = mk(
      "engagement-faq-coverage",
      "ENGAGEMENT",
      "FAQ coverage",
      rampScore(faqCount, 0, 3),
      1.5,
      faqCount === 0 ? "No FAQ questions found." : `${faqCount} FAQ question(s) present.`,
      { faqQuestions: faqCount },
    );
    if (faqCount === 0) recs.push({ id: "rec-add-faq", priority: "MEDIUM", category: "ENGAGEMENT", message: "Add an FAQ section — it captures long-tail questions and featured snippets.", relatedFactorId: engagementFaq.id });

    const ctaHits = CTA_PHRASES.filter((p) => containsPhrase(body, p)).length;
    const engagementCta = mk(
      "engagement-cta-presence",
      "ENGAGEMENT",
      "Call-to-action presence",
      ctaHits === 0 ? 0 : rampScore(ctaHits, 0, 2),
      1.5,
      ctaHits === 0 ? "No recognisable call-to-action phrase in the body." : `${ctaHits} call-to-action phrase(s) present.`,
      { ctaPhrases: ctaHits },
    );
    if (ctaHits === 0) recs.push({ id: "rec-add-cta", priority: "HIGH", category: "ENGAGEMENT", message: "Add a clear call-to-action (e.g. \"Get started\", \"Book a demo\").", relatedFactorId: engagementCta.id });

    const engagementMedia = mk(
      "engagement-media-references",
      "ENGAGEMENT",
      "Supporting media",
      rampScore(mediaRefs, 0, 3),
      1,
      mediaRefs === 0 ? "No images or embedded media referenced." : `${mediaRefs} media reference(s).`,
      { mediaReferences: mediaRefs },
    );

    // ---------- BUSINESS ----------
    const businessCta = mk(
      "business-conversion-path",
      "BUSINESS",
      "Conversion path",
      ctaHits === 0 && internalLinks === 0 ? 0 : rampScore(ctaHits + Math.min(internalLinks, 3), 0, 3),
      2,
      `${ctaHits} CTA phrase(s) and ${internalLinks} internal link(s) give the reader a next step.`,
      { ctaPhrases: ctaHits, internalLinks },
    );
    if (ctaHits === 0 && internalLinks === 0) recs.push({ id: "rec-conversion-path", priority: "HIGH", category: "BUSINESS", message: "Give the reader a next step — an internal link to a related page or a CTA.", relatedFactorId: businessCta.id });

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

    const businessAuthority = mk(
      "business-authority-links",
      "BUSINESS",
      "Outbound authority links",
      rampScore(externalLinks, 0, 2),
      1,
      externalLinks === 0 ? "No outbound links to authoritative sources." : `${externalLinks} outbound link(s).`,
      { externalLinks },
    );

    const categoryFactors: ScoringFactor[] = [
      seoTitleKeyword,
      seoKeywordCoverage,
      seoMetadata,
      seoHeadingStructure,
      viralTitleStrength,
      viralHook,
      viralOpening,
      qualityDepth,
      qualityReadability,
      qualityStructure,
      engagementFaq,
      engagementCta,
      engagementMedia,
      businessCta,
      businessBrand,
      businessAuthority,
    ];

    // ---------- Blog Score (own dimension score) ----------
    // CONTENT_SCORING_ENGINE_V1.0.md §5: Topic depth · Search intent
    // alignment · Authority · FAQ coverage · Formatting.
    const dimTopicDepth = mk("blog-topic-depth", null, "Topic depth", bandScore(words, { min: 150, idealLow: 1000, idealHigh: 2800, max: 6000, floorScore: 15 }), 2, `${words} words across ${h2plus.length} sections.`, { wordCount: words });
    const intentSignals = phraseOccurrences(`${input.title} ${body}`.toLowerCase(), "how to") + (containsPhrase(input.title, "guide") ? 1 : 0) + (faqCount > 0 ? 1 : 0);
    const dimIntent = mk("blog-search-intent", null, "Search-intent alignment", rampScore(intentSignals + kwHits, 0, 3), 1.5, `Structural signals (how-to phrasing, guide framing, FAQ, keyword use) suggest ${intentSignals + kwHits} intent match(es).`);
    const dimAuthority = mk("blog-authority", null, "Authority signals", rampScore(externalLinks + (brandHits > 0 ? 1 : 0), 0, 3), 1.5, `${externalLinks} outbound citation(s); brand referenced: ${brandHits > 0 ? "yes" : "no"}.`);
    const dimFaq = mk("blog-faq-coverage", null, "FAQ coverage", rampScore(faqCount, 0, 3), 1, faqCount === 0 ? "No FAQ." : `${faqCount} FAQ question(s).`);
    const dimFormatting = mk("blog-formatting", null, "Formatting", roundScore(weightedFactorMean([seoHeadingStructure, qualityStructure, engagementMedia])), 1.5, "Derived from heading hierarchy, section structure, and supporting media.");
    const dimensionFactors = [dimTopicDepth, dimIntent, dimAuthority, dimFaq, dimFormatting];
    const dimensionScore = roundScore(weightedFactorMean(dimensionFactors));

    return { categoryFactors, dimensionScore, dimensionFactors, recommendations: recs };
  },
};

function headingsWellNested(headings: readonly { level: number; text: string }[]): boolean {
  let prev = 0;
  for (const h of headings) {
    if (prev !== 0 && h.level > prev + 1) return false;
    prev = h.level;
  }
  return true;
}

function firstParagraph(body: string): string {
  const parts = body.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  return parts[0] ?? body.trim();
}
