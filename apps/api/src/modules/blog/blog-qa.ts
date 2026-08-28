import type { BlogDraftAgentOutput } from "@myev/shared";
import type { QaCheckResult } from "./blog-pipeline.types";

/**
 * Module 6 Phase 6.3 — FR-BLOG-006 Quality Assurance checks.
 *
 * Deterministic only. BLOG_AUTOMATION_ENGINE_V1.0 "6. Quality Assurance"
 * names six checks: Grammar, Readability, Duplicate content, Missing
 * headings, Keyword stuffing, Brand compliance. Every one is implemented
 * here as a pure, explainable heuristic — no AI provider call (the frozen
 * QA spec does not require one, and Phase 6.3's boundary forbids adding a
 * direct provider dependency). Each check yields pass/fail + explanation
 * + evidence; the pipeline never silently repairs content based on a
 * result.
 */

export interface QaInput {
  draft: BlogDraftAgentOutput;
  primaryKeyword: string;
  /** Brand terminology from the ACTIVE Knowledge Pack, if any (deterministic, KP-backed). */
  brandTerms: string[];
  /**
   * Current-version body text of every OTHER blog content item in the
   * same workspace — the limited, in-workspace corpus the duplicate check
   * compares against (Phase 6.3 has no cross-workspace / web corpus).
   */
  corpusTexts: string[];
}

const READABILITY_MAX_AVG_SENTENCE_WORDS = 30;
const KEYWORD_STUFFING_MAX_DENSITY = 0.035;
const DUPLICATE_JACCARD_THRESHOLD = 0.9;

export function renderDraftPlainText(draft: BlogDraftAgentOutput): string {
  return [
    draft.introduction,
    ...draft.bodySections.map((s) => `${s.heading}\n${s.content}`),
    draft.conclusion,
    draft.cta,
    ...draft.faqs.flatMap((f) => [f.question, f.answer]),
  ]
    .join("\n\n")
    .trim();
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function sentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function shingles(text: string, size = 3): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + size <= w.length; i++) out.add(w.slice(i, i + size).join(" "));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

function grammarCheck(text: string): QaCheckResult {
  const evidence: string[] = [];
  // Consecutive spaces WITHIN a line (paragraph breaks "\n\n" are legitimate structure, not a grammar defect).
  if (text.split("\n").some((line) => / {2,}/.test(line))) evidence.push("Contains runs of consecutive spaces.");
  if (/ i /.test(` ${text.replace(/[^a-zA-Z ]/g, " ")} `)) evidence.push('Lowercase standalone "i" used as a pronoun.');
  const lowerStart = sentences(text).filter((s) => /^[a-z]/.test(s));
  if (lowerStart.length > 0) evidence.push(`${lowerStart.length} sentence(s) do not start with a capital letter.`);
  return {
    id: "grammar",
    label: "Grammar",
    passed: evidence.length === 0,
    explanation: evidence.length === 0 ? "No mechanical grammar issues detected by the deterministic checks." : "Deterministic grammar heuristics flagged issues.",
    evidence,
  };
}

function readabilityCheck(text: string): QaCheckResult {
  const s = sentences(text);
  const avg = s.length === 0 ? 0 : words(text).length / s.length;
  const passed = avg > 0 && avg <= READABILITY_MAX_AVG_SENTENCE_WORDS;
  return {
    id: "readability",
    label: "Readability",
    passed,
    explanation: `Average sentence length is ${avg.toFixed(1)} words (target ≤ ${READABILITY_MAX_AVG_SENTENCE_WORDS}).`,
    evidence: passed ? [] : [`Sentences average ${avg.toFixed(1)} words, above the ${READABILITY_MAX_AVG_SENTENCE_WORDS}-word readability ceiling.`],
  };
}

function structureHeadingsCheck(draft: BlogDraftAgentOutput): QaCheckResult {
  const evidence: string[] = [];
  if (!draft.introduction.trim()) evidence.push("Missing introduction.");
  if (!draft.conclusion.trim()) evidence.push("Missing conclusion.");
  if (!draft.cta.trim()) evidence.push("Missing call-to-action.");
  const withHeadings = draft.bodySections.filter((sec) => sec.heading.trim().length > 0);
  if (withHeadings.length === 0) evidence.push("No body section has a heading.");
  return {
    id: "structure_headings",
    label: "Missing headings / structure",
    passed: evidence.length === 0,
    explanation: evidence.length === 0 ? `${withHeadings.length} headed body section(s), intro, conclusion and CTA all present.` : "Structural elements are missing.",
    evidence,
  };
}

function keywordStuffingCheck(text: string, primaryKeyword: string): QaCheckResult {
  const w = words(text);
  const kw = words(primaryKeyword);
  if (kw.length === 0 || w.length === 0) {
    return { id: "keyword_stuffing", label: "Keyword stuffing", passed: true, explanation: "No primary keyword or empty draft — density not applicable.", evidence: [] };
  }
  let hits = 0;
  for (let i = 0; i + kw.length <= w.length; i++) {
    if (kw.every((token, j) => w[i + j] === token)) hits++;
  }
  const density = (hits * kw.length) / w.length;
  const passed = density <= KEYWORD_STUFFING_MAX_DENSITY;
  return {
    id: "keyword_stuffing",
    label: "Keyword stuffing",
    passed,
    explanation: `Primary keyword density is ${(density * 100).toFixed(2)}% (ceiling ${(KEYWORD_STUFFING_MAX_DENSITY * 100).toFixed(1)}%).`,
    evidence: passed ? [] : [`"${primaryKeyword}" appears ${hits} time(s); density ${(density * 100).toFixed(2)}% exceeds the ${(KEYWORD_STUFFING_MAX_DENSITY * 100).toFixed(1)}% ceiling.`],
  };
}

function duplicateContentCheck(text: string, corpusTexts: string[]): QaCheckResult {
  const target = shingles(text);
  let worst = 0;
  for (const other of corpusTexts) {
    worst = Math.max(worst, jaccard(target, shingles(other)));
  }
  const passed = worst < DUPLICATE_JACCARD_THRESHOLD;
  return {
    id: "duplicate_content",
    label: "Duplicate content",
    passed,
    explanation: `Highest 3-gram Jaccard similarity against ${corpusTexts.length} other workspace blog(s) is ${worst.toFixed(2)} (limit ${DUPLICATE_JACCARD_THRESHOLD}).`,
    evidence: passed ? [] : [`Draft is ${(worst * 100).toFixed(0)}% similar to an existing workspace blog — above the ${DUPLICATE_JACCARD_THRESHOLD * 100}% near-duplicate threshold.`],
  };
}

function brandComplianceCheck(text: string, brandTerms: string[]): QaCheckResult {
  if (brandTerms.length === 0) {
    return {
      id: "brand_compliance",
      label: "Brand compliance",
      passed: true,
      explanation: "The active Knowledge Pack defines no brand terminology — nothing deterministic to enforce at this stage.",
      evidence: [],
    };
  }
  const haystack = text.toLowerCase();
  const present = brandTerms.filter((term) => haystack.includes(term.toLowerCase()));
  const passed = present.length > 0;
  return {
    id: "brand_compliance",
    label: "Brand compliance",
    passed,
    explanation: passed
      ? `Draft references ${present.length} of ${brandTerms.length} configured brand term(s).`
      : "Draft references none of the Knowledge Pack's configured brand terms.",
    evidence: passed ? [] : [`Expected at least one of: ${brandTerms.slice(0, 10).join(", ")}.`],
  };
}

export function runQaChecks(input: QaInput): QaCheckResult[] {
  const text = renderDraftPlainText(input.draft);
  return [
    grammarCheck(text),
    readabilityCheck(text),
    structureHeadingsCheck(input.draft),
    keywordStuffingCheck(text, input.primaryKeyword),
    duplicateContentCheck(text, input.corpusTexts),
    brandComplianceCheck(text, input.brandTerms),
  ];
}
