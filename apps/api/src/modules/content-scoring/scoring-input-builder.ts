import { Injectable } from "@nestjs/common";
import type { ScoringInput } from "@myev/shared";

/**
 * Module 6 Phase 6.1 — normalizes a Module 1E content item (its
 * `content_versions.body` opaque JSON) plus optional Knowledge Pack
 * context into the provider-neutral `ScoringInput` the shared engine
 * reads.
 *
 * This is the ONE place app-specific shape knowledge lives — @myev/
 * shared never sees Prisma, a KP row, or Module 1E's body JSON. The
 * builder is intentionally forgiving: Module 1E's body is opaque
 * (validated for size/depth/binary-content only, never structure), so
 * this extracts what it can from a handful of common shapes and leaves
 * the rest for a dimension to score as "missing" — it never throws on
 * an unexpected body.
 */

export interface ContentItemForScoring {
  contentType: string;
  title: string;
  currentVersionBody: unknown;
}

export interface KnowledgePackContextForScoring {
  active: boolean;
  /** Flattened keyword strings from every keyword set on the active pack. */
  keywords: string[];
  /** Brand / product terms from the active pack's brand guidelines. */
  brandTerms: string[];
}

const HEADING_KEYS = ["heading", "title", "text", "h"];
const LEVEL_KEYS = ["level", "depth", "h"];
const TEXT_KEYS = ["content", "markdown", "html", "text", "body", "value"];
// Keys whose subtree is NOT article prose — never contributes to the
// body-text extraction (their contents are read by extractMetadata()).
const NON_BODY_KEYS = new Set(["metadata", "meta", "seo", "frontmatter"]);

@Injectable()
export class ScoringInputBuilder {
  build(item: ContentItemForScoring, kp: KnowledgePackContextForScoring): ScoringInput {
    const body = item.currentVersionBody;
    const headings = this.extractHeadings(body);
    const bodyText = this.extractText(body);
    // Link/media syntax is markup — it must be detected on the RAW
    // strings, before extractText()'s stripMarkup() removes it.
    const rawText = this.collectRawStrings(body).join("\n");
    const primaryKeyword = kp.keywords[0];

    return {
      contentType: item.contentType,
      title: item.title,
      bodyText,
      headings,
      faqQuestions: this.extractFaqQuestions(body, bodyText, headings),
      internalLinkCount: this.countInternalLinks(rawText),
      externalLinkCount: this.countExternalLinks(rawText),
      mediaReferenceCount: this.countMediaReferences(body, rawText),
      metadata: this.extractMetadata(body),
      targetKeywords: kp.keywords,
      ...(primaryKeyword ? { primaryKeyword } : {}),
      brandTerms: kp.brandTerms,
      knowledgePackActive: kp.active,
    };
  }

  // ---- text ----

  private extractText(body: unknown): string {
    const parts: string[] = [];
    this.collectText(body, parts, 0);
    return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  private collectText(node: unknown, out: string[], depth: number): void {
    if (depth > 12 || node == null) return;
    if (typeof node === "string") {
      const stripped = this.stripMarkup(node);
      if (stripped.trim().length > 0) out.push(stripped);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) this.collectText(child, out, depth + 1);
      return;
    }
    if (typeof node === "object") {
      const record = node as Record<string, unknown>;
      // Prefer explicit text-bearing keys, in order, then recurse the rest.
      for (const key of TEXT_KEYS) {
        if (typeof record[key] === "string") {
          const stripped = this.stripMarkup(record[key] as string);
          if (stripped.trim().length > 0) out.push(stripped);
        }
      }
      for (const [key, value] of Object.entries(record)) {
        if (TEXT_KEYS.includes(key) && typeof value === "string") continue;
        if (NON_BODY_KEYS.has(key)) continue;
        this.collectText(value, out, depth + 1);
      }
    }
  }

  /** Every string value anywhere in the body, unmodified — for
   * markup-syntax detection (links, images). */
  private collectRawStrings(node: unknown, depth = 0, out: string[] = []): string[] {
    if (depth > 12 || node == null) return out;
    if (typeof node === "string") {
      out.push(node);
    } else if (Array.isArray(node)) {
      for (const child of node) this.collectRawStrings(child, depth + 1, out);
    } else if (typeof node === "object") {
      for (const value of Object.values(node as Record<string, unknown>)) this.collectRawStrings(value, depth + 1, out);
    }
    return out;
  }

  private stripMarkup(s: string): string {
    return s
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[#*_>`~]+/g, " ")
      .replace(/[ \t]{2,}/g, " ");
  }

  // ---- headings ----

  private extractHeadings(body: unknown): { level: number; text: string }[] {
    const headings: { level: number; text: string }[] = [];
    this.collectHeadings(body, headings, 0);

    if (headings.length === 0 && typeof this.firstString(body, "content", "markdown") === "string") {
      // Markdown ATX headings from a flat string body.
      const md = this.firstString(body, "content", "markdown") as string;
      for (const line of md.split("\n")) {
        const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
        if (m) headings.push({ level: m[1].length, text: m[2].trim() });
      }
    }
    return headings;
  }

  private collectHeadings(node: unknown, out: { level: number; text: string }[], depth: number): void {
    if (depth > 12 || node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) this.collectHeadings(child, out, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const typeVal = typeof record.type === "string" ? (record.type as string).toLowerCase() : "";
    const isHeadingNode =
      /^h[1-6]$/.test(typeVal) ||
      typeVal === "heading" ||
      (record.heading !== undefined && typeof record.heading === "string");
    if (isHeadingNode) {
      const text = this.firstString(record, ...HEADING_KEYS);
      const level = this.headingLevel(record, typeVal);
      if (typeof text === "string" && text.trim().length > 0) out.push({ level, text: text.trim() });
    }
    for (const value of Object.values(record)) this.collectHeadings(value, out, depth + 1);
  }

  private headingLevel(record: Record<string, unknown>, typeVal: string): number {
    const hMatch = /^h([1-6])$/.exec(typeVal);
    if (hMatch) return Number(hMatch[1]);
    for (const key of LEVEL_KEYS) {
      const v = record[key];
      if (typeof v === "number" && v >= 1 && v <= 6) return Math.floor(v);
      if (typeof v === "string" && /^[1-6]$/.test(v)) return Number(v);
    }
    return 2;
  }

  // ---- faq ----

  private extractFaqQuestions(body: unknown, bodyText: string, headings: { level: number; text: string }[]): string[] {
    const questions = new Set<string>();
    // explicit faq arrays
    this.collectFaq(body, questions, 0);
    // heading that looks like a question
    for (const h of headings) if (h.text.trim().endsWith("?")) questions.add(h.text.trim());
    // question-shaped lines in the body
    for (const line of bodyText.split("\n")) {
      const t = line.trim();
      if (t.length > 8 && t.length < 200 && t.endsWith("?")) questions.add(t);
    }
    return [...questions];
  }

  private collectFaq(node: unknown, out: Set<string>, depth: number): void {
    if (depth > 12 || node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) this.collectFaq(child, out, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.question === "string" && record.question.trim().length > 0) out.add(record.question.trim());
    for (const value of Object.values(record)) this.collectFaq(value, out, depth + 1);
  }

  // ---- links / media ----

  /** Markdown links minus image embeds (which share the `](...)` tail). */
  private linksOnly(text: string): string {
    return text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  }

  private countInternalLinks(text: string): number {
    const links = this.linksOnly(text);
    return (
      (links.match(/\]\(\/[^)]*\)/g)?.length ?? 0) +
      (links.match(/href=["']\/[^"']*["']/g)?.length ?? 0)
    );
  }

  private countExternalLinks(text: string): number {
    const links = this.linksOnly(text);
    return (
      (links.match(/\]\(https?:\/\/[^)]*\)/g)?.length ?? 0) +
      (links.match(/href=["']https?:\/\/[^"']*["']/g)?.length ?? 0)
    );
  }

  private countMediaReferences(body: unknown, text: string): number {
    let count = (text.match(/!\[[^\]]*\]\([^)]*\)/g)?.length ?? 0) + (text.match(/<img\b/gi)?.length ?? 0);
    const walk = (node: unknown, depth: number): void => {
      if (depth > 12 || node == null || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach((c) => walk(c, depth + 1));
      const record = node as Record<string, unknown>;
      const typeVal = typeof record.type === "string" ? (record.type as string).toLowerCase() : "";
      if (typeVal === "image" || typeVal === "img" || typeVal === "video" || record.imageUrl !== undefined || record.src !== undefined) count += 1;
      Object.values(record).forEach((v) => walk(v, depth + 1));
    };
    walk(body, 0);
    return count;
  }

  // ---- metadata ----

  private extractMetadata(body: unknown): ScoringInput["metadata"] {
    if (body == null || typeof body !== "object") return {};
    const record = body as Record<string, unknown>;
    const meta = (typeof record.metadata === "object" && record.metadata !== null ? record.metadata : record) as Record<string, unknown>;
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) if (typeof meta[k] === "string" && (meta[k] as string).trim().length > 0) return (meta[k] as string).trim();
      return undefined;
    };
    const metaTitle = pick("metaTitle", "seoTitle", "meta_title");
    const metaDescription = pick("metaDescription", "seoDescription", "meta_description", "description");
    const urlSlug = pick("urlSlug", "slug", "url_slug");
    const schema = meta.schemaMarkup ?? meta.schema ?? meta.jsonLd;
    const hasSchemaMarkup = schema !== undefined && schema !== null && !(typeof schema === "object" && Object.keys(schema).length === 0);
    return {
      ...(metaTitle ? { metaTitle } : {}),
      ...(metaDescription ? { metaDescription } : {}),
      ...(urlSlug ? { urlSlug } : {}),
      ...(hasSchemaMarkup ? { hasSchemaMarkup: true } : {}),
    };
  }

  // ---- helpers ----

  private firstString(node: unknown, ...keys: string[]): string | undefined {
    if (node == null || typeof node !== "object") return undefined;
    const record = node as Record<string, unknown>;
    for (const key of keys) if (typeof record[key] === "string") return record[key] as string;
    return undefined;
  }
}
