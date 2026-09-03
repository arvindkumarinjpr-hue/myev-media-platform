/**
 * Module 8 Phase 8.2 — minimal, independent text extraction over the
 * SAME opaque `content_versions.body` contract Module 1E/6 already
 * established (validated for size/depth/binary-content only, never
 * structure — see scoring-input-builder.ts's own doc comment).
 *
 * Deliberately NOT a reuse of Module 6's ScoringInputBuilder: its
 * extraction methods are private, and ContentScoringModule does not
 * export the class itself (only ContentScoringService) — importing or
 * exporting Module 6 internals for Module 8's use would mean modifying a
 * frozen Module 6 file, which Phase 8.2 does not do. This is a small,
 * independently-owned equivalent, not a fork of the same code.
 */

const TEXT_KEYS = ["content", "markdown", "html", "text", "body", "value", "title"];
const NON_BODY_KEYS = new Set(["metadata", "meta", "seo", "frontmatter"]);

function collectRawStrings(node: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 12 || node === null || node === undefined) return out;
  if (typeof node === "string") {
    if (node.trim()) out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectRawStrings(child, depth + 1, out);
    return out;
  }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (NON_BODY_KEYS.has(key)) continue;
      if (typeof value === "string" && !TEXT_KEYS.includes(key)) continue;
      collectRawStrings(value, depth + 1, out);
    }
  }
  return out;
}

function stripMarkup(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => m.replace(/\[([^\]]*)\]\([^)]*\)/, "$1")) // links -> label text
    .replace(/<[^>]+>/g, " ") // HTML tags
    .replace(/[#*_>~`]/g, " ") // markdown syntax chars
    .replace(/\s+/g, " ")
    .trim();
}

/** Plain, markup-stripped text extracted from an opaque body — never throws on an unexpected shape. */
export function extractPlainText(title: string, body: unknown): string {
  const raw = collectRawStrings(body).join("\n");
  return [title, stripMarkup(raw)].filter(Boolean).join("\n");
}

const LINK_PATTERNS = [/\]\((\/[^)\s]*)\)/g, /href=["'](\/[^"']*)["']/g];

/** Relative-path link targets found in the body's RAW (pre-strip) markup — same regex shape Module 6's own countInternalLinks() uses, independently implemented. */
export function extractRelativeLinkPaths(body: unknown): string[] {
  const raw = collectRawStrings(body).join("\n");
  const paths: string[] = [];
  for (const pattern of LINK_PATTERNS) {
    for (const match of raw.matchAll(pattern)) {
      if (match[1]) paths.push(match[1]);
    }
  }
  return paths;
}

export function countRelativeLinks(body: unknown): number {
  return extractRelativeLinkPaths(body).length;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "is", "are", "was", "were",
  "be", "by", "at", "as", "it", "this", "that", "your", "you", "how", "what", "why", "when", "guide",
]);

/** Lowercase, punctuation-stripped, stopword-filtered token set — for the title/content overlap fallback. */
export function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  return new Set(tokens);
}
