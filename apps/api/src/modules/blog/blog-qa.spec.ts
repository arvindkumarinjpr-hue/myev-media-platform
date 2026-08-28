import type { BlogDraftAgentOutput } from "@myev/shared";
import { renderDraftPlainText, runQaChecks } from "./blog-qa";

const goodDraft: BlogDraftAgentOutput = {
  introduction: "Charging an electric vehicle at home is the cheapest and most convenient way to keep your car ready. This guide walks a new owner through the essentials.",
  bodySections: [
    { level: 2, heading: "Why charge at home", content: "A home Level 2 setup costs less per mile than public charging. It is ready every morning. Most owners install one in the garage within a day." },
    { level: 2, heading: "Choosing a charger", content: "Look at amperage, cable length, and smart scheduling. A forty amp unit adds about thirty miles of range each hour for a typical car." },
  ],
  conclusion: "Home charging pays for itself within a year for most drivers who plug in nightly.",
  cta: "Book a free home charger installation assessment today.",
  faqs: [{ question: "How much does home charging cost?", answer: "Usually a few hundred dollars to install, plus your normal electricity rate." }],
};

describe("blog-qa", () => {
  it("renders the draft to plain text covering every section", () => {
    const text = renderDraftPlainText(goodDraft);
    expect(text).toContain("Why charge at home");
    expect(text).toContain("How much does home charging cost?");
  });

  it("runs exactly the six FR-BLOG-006 checks, each with pass/fail + explanation", () => {
    const checks = runQaChecks({ draft: goodDraft, primaryKeyword: "home ev charging", brandTerms: [], corpusTexts: [] });
    expect(checks.map((c) => c.id).sort()).toEqual(["brand_compliance", "duplicate_content", "grammar", "keyword_stuffing", "readability", "structure_headings"]);
    for (const c of checks) {
      expect(typeof c.passed).toBe("boolean");
      expect(c.explanation.length).toBeGreaterThan(0);
    }
  });

  it("passes a clean, well-structured draft", () => {
    const checks = runQaChecks({ draft: goodDraft, primaryKeyword: "home ev charging", brandTerms: [], corpusTexts: [] });
    expect(checks.every((c) => c.passed)).toBe(true);
  });

  it("fails keyword stuffing when the primary keyword is repeated far too often", () => {
    const stuffed: BlogDraftAgentOutput = {
      ...goodDraft,
      bodySections: [{ level: 2, heading: "EV", content: Array(40).fill("home ev charging").join(" ") }],
    };
    const kw = runQaChecks({ draft: stuffed, primaryKeyword: "home ev charging", brandTerms: [], corpusTexts: [] }).find((c) => c.id === "keyword_stuffing")!;
    expect(kw.passed).toBe(false);
    expect(kw.evidence.length).toBeGreaterThan(0);
  });

  it("fails duplicate content against a near-identical corpus entry", () => {
    const text = renderDraftPlainText(goodDraft);
    const dup = runQaChecks({ draft: goodDraft, primaryKeyword: "home ev charging", brandTerms: [], corpusTexts: [text] }).find((c) => c.id === "duplicate_content")!;
    expect(dup.passed).toBe(false);
  });

  it("fails structure when a draft has no headed body sections", () => {
    const noHeadings: BlogDraftAgentOutput = { ...goodDraft, bodySections: [{ level: 2, heading: "", content: "text" }] };
    const structure = runQaChecks({ draft: noHeadings, primaryKeyword: "k", brandTerms: [], corpusTexts: [] }).find((c) => c.id === "structure_headings")!;
    expect(structure.passed).toBe(false);
  });

  it("brand compliance passes vacuously when the KP defines no brand terms, fails when configured terms are absent", () => {
    const noTerms = runQaChecks({ draft: goodDraft, primaryKeyword: "k", brandTerms: [], corpusTexts: [] }).find((c) => c.id === "brand_compliance")!;
    expect(noTerms.passed).toBe(true);
    const missing = runQaChecks({ draft: goodDraft, primaryKeyword: "k", brandTerms: ["Voltiq", "ChargeforceX"], corpusTexts: [] }).find((c) => c.id === "brand_compliance")!;
    expect(missing.passed).toBe(false);
  });
});
