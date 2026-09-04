import { parseBlogPublishingDraft, renderBlogPublishingHtml, resolveBlogPublishingContent, type BlogPublishingDraft } from "./blog-publishing-content";

function validDraft(overrides: Partial<BlogPublishingDraft> = {}): BlogPublishingDraft {
  return {
    introduction: "This is the introduction.",
    bodySections: [
      { level: 2, heading: "First Section", content: "First section body." },
      { level: 3, heading: "Nested Section", content: "Nested section body." },
    ],
    conclusion: "This is the conclusion.",
    cta: "Sign up today.",
    faqs: [],
    ...overrides,
  };
}

describe("parseBlogPublishingDraft", () => {
  it("accepts a well-formed draft", () => {
    expect(parseBlogPublishingDraft(validDraft())).toEqual(validDraft());
  });

  it.each([null, undefined, "a string", 42, []])("rejects a non-object value: %p", (value) => {
    expect(parseBlogPublishingDraft(value)).toBeNull();
  });

  it("rejects a missing introduction/conclusion/cta", () => {
    expect(parseBlogPublishingDraft({ ...validDraft(), introduction: "" })).toBeNull();
    expect(parseBlogPublishingDraft({ ...validDraft(), conclusion: undefined })).toBeNull();
    expect(parseBlogPublishingDraft({ ...validDraft(), cta: 123 })).toBeNull();
  });

  it("rejects an empty or missing bodySections array", () => {
    expect(parseBlogPublishingDraft({ ...validDraft(), bodySections: [] })).toBeNull();
    expect(parseBlogPublishingDraft({ ...validDraft(), bodySections: undefined })).toBeNull();
  });

  it("rejects a malformed section (missing heading/content, non-numeric level)", () => {
    expect(parseBlogPublishingDraft({ ...validDraft(), bodySections: [{ level: 2, heading: "", content: "x" }] })).toBeNull();
    expect(parseBlogPublishingDraft({ ...validDraft(), bodySections: [{ level: "2", heading: "H", content: "x" }] })).toBeNull();
  });

  it("rejects a malformed faq entry", () => {
    expect(parseBlogPublishingDraft({ ...validDraft(), faqs: [{ question: "Q" }] })).toBeNull();
  });

  it("accepts an empty faqs array", () => {
    expect(parseBlogPublishingDraft(validDraft({ faqs: [] }))?.faqs).toEqual([]);
  });
});

describe("renderBlogPublishingHtml", () => {
  it("renders introduction, sections, conclusion, and cta in order", () => {
    const { format, body } = renderBlogPublishingHtml(validDraft());
    expect(format).toBe("HTML");
    expect(body).toBe(
      [
        "<p>This is the introduction.</p>",
        "<h2>First Section</h2>",
        "<p>First section body.</p>",
        "<h3>Nested Section</h3>",
        "<p>Nested section body.</p>",
        "<h2>Conclusion</h2>",
        "<p>This is the conclusion.</p>",
        "<p><strong>Sign up today.</strong></p>",
      ].join("\n"),
    );
  });

  it("HTML-escapes introduction/section/conclusion/cta/faq text", () => {
    const draft = validDraft({
      introduction: `<script>alert("x")</script> & "quotes" 'single'`,
      bodySections: [{ level: 2, heading: "<h1>Injected</h1>", content: "Body & <b>bold</b>" }],
      cta: `Click & "go"`,
      faqs: [{ question: "<b>Q</b>", answer: "A & B" }],
    });
    const { body } = renderBlogPublishingHtml(draft);
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<h1>Injected</h1>");
    expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;quotes&quot; &#39;single&#39;");
    expect(body).toContain("&lt;h1&gt;Injected&lt;/h1&gt;");
    expect(body).toContain("Body &amp; &lt;b&gt;bold&lt;/b&gt;");
    expect(body).toContain("Click &amp; &quot;go&quot;");
    expect(body).toContain("&lt;b&gt;Q&lt;/b&gt;");
    expect(body).toContain("A &amp; B");
  });

  it.each([
    [2, "h2"],
    [3, "h3"],
    [4, "h4"],
  ])("maps section level %i to <%s>", (level, tag) => {
    const { body } = renderBlogPublishingHtml(validDraft({ bodySections: [{ level, heading: "H", content: "C" }] }));
    expect(body).toContain(`<${tag}>H</${tag}>`);
  });

  it.each([1, 0, -5, 99])("clamps an out-of-range level (%i) into the established 2..4 range", (level) => {
    const { body } = renderBlogPublishingHtml(validDraft({ bodySections: [{ level, heading: "H", content: "C" }] }));
    const clamped = Math.min(Math.max(level, 2), 4);
    expect(body).toContain(`<h${clamped}>H</h${clamped}>`);
  });

  it("omits the FAQ section entirely when faqs is empty", () => {
    const { body } = renderBlogPublishingHtml(validDraft({ faqs: [] }));
    expect(body).not.toContain("FAQ");
  });

  it("renders an FAQ section — h2 FAQ, h3 per question, p per answer — only when faqs is non-empty", () => {
    const { body } = renderBlogPublishingHtml(validDraft({ faqs: [{ question: "What is it?", answer: "It is this." }] }));
    expect(body).toContain(["<h2>FAQ</h2>", "<h3>What is it?</h3>", "<p>It is this.</p>"].join("\n"));
  });

  it("never mutates the input draft object", () => {
    const draft = validDraft();
    const frozen = JSON.parse(JSON.stringify(draft));
    renderBlogPublishingHtml(draft);
    expect(draft).toEqual(frozen);
  });

  it("never reinterprets Markdown syntax inside the structured text fields", () => {
    const draft = validDraft({ introduction: "**bold** and # not-a-heading and [link](http://example.com)" });
    const { body } = renderBlogPublishingHtml(draft);
    // Escaped literally — no <strong>/<a> ever produced from this text.
    expect(body).toContain("**bold** and # not-a-heading and [link](http://example.com)");
    expect(body).not.toContain("<strong>bold</strong>");
    expect(body).not.toContain('<a href="http://example.com">');
  });
});

describe("resolveBlogPublishingContent", () => {
  it("returns the rendered payload for a well-formed draft", () => {
    const result = resolveBlogPublishingContent(validDraft());
    expect(result?.format).toBe("HTML");
    expect(result?.body).toContain("<p>This is the introduction.</p>");
  });

  it("returns null for a missing/malformed draft, never throws", () => {
    expect(resolveBlogPublishingContent(null)).toBeNull();
    expect(resolveBlogPublishingContent(undefined)).toBeNull();
    expect(resolveBlogPublishingContent({ introduction: "only this field" })).toBeNull();
  });
});
