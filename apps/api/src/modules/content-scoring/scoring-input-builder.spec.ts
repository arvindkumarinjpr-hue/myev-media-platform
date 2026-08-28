import { ScoringInputBuilder } from "./scoring-input-builder";

const builder = new ScoringInputBuilder();
const NO_KP = { active: false, keywords: [], brandTerms: [] };

describe("ScoringInputBuilder", () => {
  it("extracts plain text from Module 1E's simplest body shape ({ content: string })", () => {
    const input = builder.build({ contentType: "BLOG", title: "Hello", currentVersionBody: { content: "Hello world. This is a body." } }, NO_KP);
    expect(input.bodyText).toContain("Hello world");
    expect(input.contentType).toBe("BLOG");
    expect(input.knowledgePackActive).toBe(false);
  });

  it("pulls ATX markdown headings out of a flat string body", () => {
    const md = "# Title\n\nIntro paragraph.\n\n## First section\n\nText.\n\n### Detail\n\nMore.";
    const input = builder.build({ contentType: "BLOG", title: "Title", currentVersionBody: { markdown: md } }, NO_KP);
    expect(input.headings).toEqual([
      { level: 1, text: "Title" },
      { level: 2, text: "First section" },
      { level: 3, text: "Detail" },
    ]);
  });

  it("reads a structured block body (typed nodes) for headings and text", () => {
    const body = {
      blocks: [
        { type: "h1", text: "Guide" },
        { type: "paragraph", text: "An intro." },
        { type: "heading", level: 2, heading: "Setup" },
        { type: "paragraph", content: "Do the thing." },
      ],
    };
    const input = builder.build({ contentType: "BLOG", title: "Guide", currentVersionBody: body }, NO_KP);
    expect(input.headings).toEqual([
      { level: 1, text: "Guide" },
      { level: 2, text: "Setup" },
    ]);
    expect(input.bodyText).toContain("An intro.");
    expect(input.bodyText).toContain("Do the thing.");
  });

  it("counts internal vs external links and media references from markdown", () => {
    const md = "See [our guide](/guides/ev) and [Wikipedia](https://en.wikipedia.org/x). ![diagram](/img/a.png)";
    const input = builder.build({ contentType: "BLOG", title: "T", currentVersionBody: { content: md } }, NO_KP);
    expect(input.internalLinkCount).toBe(1);
    expect(input.externalLinkCount).toBe(1);
    expect(input.mediaReferenceCount).toBe(1);
  });

  it("collects FAQ questions from an explicit array, question headings, and question lines", () => {
    const body = {
      content: "## How much does it cost?\n\nAbout $500.\n\nIs a permit required?",
      faq: [{ question: "Do I need an electrician?" }],
    };
    const input = builder.build({ contentType: "BLOG", title: "T", currentVersionBody: body }, NO_KP);
    expect(input.faqQuestions).toEqual(expect.arrayContaining(["How much does it cost?", "Is a permit required?", "Do I need an electrician?"]));
  });

  it("extracts SEO metadata from a top-level or nested metadata object", () => {
    const nested = builder.build(
      { contentType: "BLOG", title: "T", currentVersionBody: { content: "x", metadata: { metaTitle: "MT", metaDescription: "MD", slug: "my-slug", schemaMarkup: { "@type": "Article" } } } },
      NO_KP,
    );
    expect(nested.metadata).toEqual({ metaTitle: "MT", metaDescription: "MD", urlSlug: "my-slug", hasSchemaMarkup: true });

    const flat = builder.build({ contentType: "BLOG", title: "T", currentVersionBody: { content: "x", seoTitle: "S", description: "D" } }, NO_KP);
    expect(flat.metadata?.metaTitle).toBe("S");
    expect(flat.metadata?.metaDescription).toBe("D");
  });

  it("threads Knowledge Pack keywords + brand terms through, and marks the pack active", () => {
    const input = builder.build(
      { contentType: "BLOG", title: "T", currentVersionBody: { content: "x" } },
      { active: true, keywords: ["home ev charging", "level 2"], brandTerms: ["EVolt"] },
    );
    expect(input.targetKeywords).toEqual(["home ev charging", "level 2"]);
    expect(input.primaryKeyword).toBe("home ev charging");
    expect(input.brandTerms).toEqual(["EVolt"]);
    expect(input.knowledgePackActive).toBe(true);
  });

  it("never throws on an unexpected / empty body", () => {
    for (const b of [{}, null, [], "just a string", { random: { nested: 42 } }, { blocks: [{ type: "unknown" }] }]) {
      expect(() => builder.build({ contentType: "BLOG", title: "T", currentVersionBody: b }, NO_KP)).not.toThrow();
    }
  });

  it("is deterministic — same item + context yields identical output", () => {
    const item = { contentType: "BLOG", title: "T", currentVersionBody: { content: "## A\n\ntext\n\n## B?\n\nmore" } };
    expect(JSON.stringify(builder.build(item, NO_KP))).toBe(JSON.stringify(builder.build(item, NO_KP)));
  });
});
