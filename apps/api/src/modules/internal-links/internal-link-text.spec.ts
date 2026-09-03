import { countRelativeLinks, extractPlainText, extractRelativeLinkPaths, tokenize } from "./internal-link-text";

describe("extractPlainText", () => {
  it("strips markdown syntax and includes the title", () => {
    const body = { content: "# Heading\n\nSome **bold** text with a [link](/other-post) inside." };
    const text = extractPlainText("EV Charging Guide", body);
    expect(text).toContain("EV Charging Guide");
    expect(text).toContain("Heading");
    expect(text).toContain("bold");
    expect(text).toContain("link");
    expect(text).not.toContain("**");
    expect(text).not.toContain("[link]");
  });

  it("strips HTML tags", () => {
    const text = extractPlainText("T", { html: "<p>Hello <strong>world</strong></p>" });
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).not.toContain("<p>");
  });

  it("never throws on an unexpected/malformed body shape", () => {
    expect(() => extractPlainText("T", null)).not.toThrow();
    expect(() => extractPlainText("T", undefined)).not.toThrow();
    expect(() => extractPlainText("T", 42)).not.toThrow();
    expect(() => extractPlainText("T", { nonsense: { deeply: { nested: [1, 2, { a: "b" }] } } })).not.toThrow();
  });

  it("excludes metadata/frontmatter subtrees from body text", () => {
    const text = extractPlainText("T", { content: "Real prose.", metadata: { secretInternalNote: "should not appear" } });
    expect(text).toContain("Real prose");
    expect(text).not.toContain("secretInternalNote");
  });
});

describe("extractRelativeLinkPaths / countRelativeLinks", () => {
  it("extracts markdown relative link paths", () => {
    const body = { content: "See [our guide](/blog/ev-charging-101) and [external](https://example.com/x)." };
    expect(extractRelativeLinkPaths(body)).toEqual(["/blog/ev-charging-101"]);
    expect(countRelativeLinks(body)).toBe(1);
  });

  it("extracts HTML href relative link paths", () => {
    const body = { html: '<a href="/blog/charging-networks">networks</a>' };
    expect(extractRelativeLinkPaths(body)).toEqual(["/blog/charging-networks"]);
  });

  it("returns an empty array when there are no relative links", () => {
    expect(extractRelativeLinkPaths({ content: "No links here." })).toEqual([]);
    expect(countRelativeLinks(null)).toBe(0);
  });
});

describe("tokenize", () => {
  it("lowercases, strips punctuation, and filters stopwords/short tokens", () => {
    const tokens = tokenize("The Best EV Charging Guide for 2026!");
    expect(tokens.has("the")).toBe(false); // stopword
    expect(tokens.has("for")).toBe(false); // stopword
    expect(tokens.has("charging")).toBe(true);
    expect(tokens.has("guide")).toBe(false); // in the extended stopword list (common title noise)
    expect([...tokens].every((t) => /^[a-z0-9]+$/.test(t))).toBe(true);
  });

  it("produces an empty set for empty/whitespace input", () => {
    expect(tokenize("").size).toBe(0);
    expect(tokenize("   ").size).toBe(0);
  });
});
