/**
 * Module 8 Phase 8.3 — deterministic anchor candidate generation +
 * structural validation. Pure functions, no DB access — the service
 * layer (internal-link-anchor.service.ts) resolves target metadata,
 * brand/competitor terms, and exact-match-repeat history, then hands
 * primitives here.
 *
 * No AI, no rewritten prose: every non-fallback candidate is a phrase
 * ALREADY PRESENT in the source body, found verbatim (case-insensitively
 * matched, original casing preserved) — never synthesized.
 */

export type AnchorSelectionSource = "target-primary-keyword" | "target-title-subphrase" | "target-title-fallback";

export interface AnchorCandidate {
  phrase: string;
  source: AnchorSelectionSource;
}

export interface AnchorValidationResult {
  valid: boolean;
  reason?: string;
}

const MIN_WORDS = 2;
const MAX_WORDS = 8;
const MAX_CHARS = 60;

const TITLE_STOPWORDS = new Set(["the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "is", "are", "how", "what", "why", "when", "your", "you", "this", "that"]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive, whole-word search — returns the ORIGINAL-cased substring from `haystack` if found, else null. Never a synthesized phrase. */
function findNaturalPhrase(haystack: string, phrase: string): string | null {
  const trimmed = phrase.trim();
  if (!trimmed) return null;
  const pattern = new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, "i");
  const match = haystack.match(pattern);
  return match ? match[0] : null;
}

function titleWords(title: string): string[] {
  return title
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Longest-to-shortest contiguous n-grams (6..2 words) of the target
 * title, skipping any n-gram that starts or ends on a stopword (keeps
 * candidates reading as a natural phrase, not a sentence fragment).
 */
function titleNGrams(title: string): string[] {
  const words = titleWords(title);
  const grams: string[] = [];
  for (let len = Math.min(6, words.length); len >= 2; len--) {
    for (let start = 0; start + len <= words.length; start++) {
      const slice = words.slice(start, start + len);
      const first = slice[0].toLowerCase();
      const last = slice[slice.length - 1].toLowerCase();
      if (TITLE_STOPWORDS.has(first) || TITLE_STOPWORDS.has(last)) continue;
      grams.push(slice.join(" "));
    }
  }
  return grams;
}

/**
 * Ordered candidate list per the approved architecture's preferred
 * order. A 3rd "other repository-supported target terminology" tier is
 * deliberately NOT implemented: beyond primary keyword and title, no
 * other truthful per-target-item terminology source exists in the
 * current schema (verified — BlogArticle has no tags/keyword-list field;
 * per-article "secondary keywords" are not queried here since they were
 * not verified as reliably present the way primaryKeyword is). The final
 * fallback (target title) is always appended last and is NEVER filtered
 * out by this function — callers must always have at least one candidate.
 */
export function buildCandidates(sourceText: string, targetTitle: string, targetPrimaryKeyword: string | null): AnchorCandidate[] {
  const candidates: AnchorCandidate[] = [];

  if (targetPrimaryKeyword) {
    const natural = findNaturalPhrase(sourceText, targetPrimaryKeyword);
    if (natural) candidates.push({ phrase: natural, source: "target-primary-keyword" });
  }

  for (const gram of titleNGrams(targetTitle)) {
    const natural = findNaturalPhrase(sourceText, gram);
    if (natural) candidates.push({ phrase: natural, source: "target-title-subphrase" });
  }

  candidates.push({ phrase: targetTitle.trim(), source: "target-title-fallback" });
  return candidates;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function isUrlLike(s: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(s) || s.includes("://");
}

function hasRepeatedWordAbuse(words: string[]): boolean {
  const counts = new Map<string, number>();
  for (const w of words) {
    const key = w.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.get(key)! > 2) return true;
  }
  return false;
}

/**
 * Structural validation only (length/shape/blocked-terms) — the
 * exact-match-repeat check needs DB history and lives in the service
 * layer. Deliberately no word-count exception for short brand/entity
 * names: no per-item entity data exists in the current schema reliable
 * enough to justify carving one out (Phase 8.3 architecture instruction:
 * "do not invent a silent exception").
 */
/** "chargepoint.com" / "https://www.chargepoint.com/x" -> "chargepoint". Null for anything too short to be a meaningful token. */
export function extractDomainToken(domain: string): string | null {
  const cleaned = domain
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0];
  const token = cleaned.split(".")[0]?.trim().toLowerCase();
  return token && token.length > 1 ? token : null;
}

export function validateAnchorStructure(phrase: string, blockedTerms: string[]): AnchorValidationResult {
  const normalized = normalizeWhitespace(phrase);
  if (!normalized) return { valid: false, reason: "empty-after-normalization" };
  if (!/[a-zA-Z0-9]/.test(normalized)) return { valid: false, reason: "punctuation-only" };
  if (isUrlLike(normalized)) return { valid: false, reason: "url-like" };
  if (/[.!?]/.test(normalized)) return { valid: false, reason: "sentence-like" };

  const words = normalized.split(" ");
  if (words.length < MIN_WORDS) return { valid: false, reason: "below-min-words" };
  if (words.length > MAX_WORDS) return { valid: false, reason: "above-max-words" };
  if (normalized.length > MAX_CHARS) return { valid: false, reason: "above-max-chars" };
  if (hasRepeatedWordAbuse(words)) return { valid: false, reason: "keyword-stuffing" };

  const lowerWords = new Set(words.map((w) => w.toLowerCase()));
  for (const blocked of blockedTerms) {
    if (lowerWords.has(blocked.toLowerCase())) return { valid: false, reason: `blocked-term:${blocked}` };
  }

  return { valid: true };
}
