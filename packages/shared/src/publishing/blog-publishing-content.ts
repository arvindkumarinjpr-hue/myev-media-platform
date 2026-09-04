import type { PublishingContentPayload } from "./publishing-provider.interface";

/**
 * Module 9 Phase 9.4 — the narrow, typed shape of `ContentVersion.body.blogDraft`
 * for a BLOG content item, mirroring `BlogDraftAgentOutput`'s own fields
 * exactly (packages/shared/src/agent-framework/agents/blog-draft-agent.ts)
 * — the real, typed agent output `blog-pipeline.service.ts`'s own
 * `renderDraftBody()` stores verbatim under this key. This is the
 * authoritative structured publishing source for BLOG content; the
 * markdown `body.content` string built alongside it is never used for
 * publishing.
 */
export interface BlogPublishingDraftSection {
  level: number;
  heading: string;
  content: string;
}

export interface BlogPublishingDraftFaq {
  question: string;
  answer: string;
}

export interface BlogPublishingDraft {
  introduction: string;
  bodySections: BlogPublishingDraftSection[];
  conclusion: string;
  cta: string;
  faqs: BlogPublishingDraftFaq[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidSection(value: unknown): value is BlogPublishingDraftSection {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return typeof s.level === "number" && isNonEmptyString(s.heading) && isNonEmptyString(s.content);
}

function isValidFaq(value: unknown): value is BlogPublishingDraftFaq {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return isNonEmptyString(f.question) && isNonEmptyString(f.answer);
}

/**
 * Narrows `ContentVersion.body.blogDraft` (an opaque `unknown` value, as
 * read directly off the Json column) into a `BlogPublishingDraft`, or
 * `null` if the shape is missing/malformed — never throws. Both apps/api
 * and apps/worker's own facts-builders call this after their own
 * mechanical Prisma fetch extracts `body.blogDraft`; this function itself
 * never touches Prisma/the DB.
 */
export function parseBlogPublishingDraft(raw: unknown): BlogPublishingDraft | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (!isNonEmptyString(d.introduction) || !isNonEmptyString(d.conclusion) || !isNonEmptyString(d.cta)) return null;
  if (!Array.isArray(d.bodySections) || d.bodySections.length === 0 || !d.bodySections.every(isValidSection)) return null;
  if (!Array.isArray(d.faqs) || !d.faqs.every(isValidFaq)) return null;
  return {
    introduction: d.introduction,
    bodySections: d.bodySections as BlogPublishingDraftSection[],
    conclusion: d.conclusion,
    cta: d.cta,
    faqs: d.faqs as BlogPublishingDraftFaq[],
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Mirrors blog-pipeline.service.ts's own renderDraftBody() clamp exactly — the agent itself only ever emits level 2-3 (BlogDraftBodySection's own @Min(2)/@Max(3)), but this stays defensive to the same 2..4 range the markdown renderer already established. */
function clampHeadingLevel(level: number): 2 | 3 | 4 {
  return Math.min(Math.max(Math.trunc(level), 2), 4) as 2 | 3 | 4;
}

/**
 * Deterministically renders a `BlogPublishingDraft` into simple, semantic
 * HTML suitable for a WordPress post body. Every text field is treated as
 * plain text and HTML-escaped — the stored strings are never reinterpreted
 * as Markdown or HTML. No styling/classes are added. Pure — no I/O, no
 * randomness, never mutates its input.
 */
export function renderBlogPublishingHtml(draft: BlogPublishingDraft): PublishingContentPayload {
  const parts: string[] = [];

  parts.push(`<p>${escapeHtml(draft.introduction)}</p>`);

  for (const section of draft.bodySections) {
    const tag = `h${clampHeadingLevel(section.level)}`;
    parts.push(`<${tag}>${escapeHtml(section.heading)}</${tag}>`);
    parts.push(`<p>${escapeHtml(section.content)}</p>`);
  }

  parts.push(`<h2>Conclusion</h2>`);
  parts.push(`<p>${escapeHtml(draft.conclusion)}</p>`);

  parts.push(`<p><strong>${escapeHtml(draft.cta)}</strong></p>`);

  if (draft.faqs.length > 0) {
    parts.push(`<h2>FAQ</h2>`);
    for (const faq of draft.faqs) {
      parts.push(`<h3>${escapeHtml(faq.question)}</h3>`);
      parts.push(`<p>${escapeHtml(faq.answer)}</p>`);
    }
  }

  return { format: "HTML", body: parts.join("\n") };
}

/** Convenience: parse + render in one call. Returns `null` if `raw` (the ContentVersion.body.blogDraft value) is missing/malformed — the caller (a readiness facts-builder or the execution service) is responsible for turning that into the appropriate blocking reason / execution failure. */
export function resolveBlogPublishingContent(raw: unknown): PublishingContentPayload | null {
  const draft = parseBlogPublishingDraft(raw);
  return draft ? renderBlogPublishingHtml(draft) : null;
}
