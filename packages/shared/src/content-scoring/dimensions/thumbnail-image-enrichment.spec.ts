import { VIDEO_DIMENSION_V1 } from "./video-dimension";
import { THUMBNAIL_DIMENSION_V1 } from "./thumbnail-dimension";
import type { ScoringInput } from "../scoring-input";

const baseVideo: ScoringInput = {
  contentType: "VIDEO",
  title: "Home EV charging explained",
  bodyText: "A clear hook. Then several segments of narration explaining home charging in India.",
  headings: [{ level: 2, text: "Intro" }],
  targetKeywords: ["ev charging"],
  primaryKeyword: "ev charging",
  brandTerms: [],
  knowledgePackActive: true,
  targetPlatform: "YOUTUBE_LONG",
};

const baseThumb: ScoringInput = {
  contentType: "VIDEO_THUMBNAIL_CONCEPT",
  title: "Shocked reaction + charger",
  bodyText: "Close-up of a surprised face next to a wall charger, bright yellow accent.",
  metadata: { metaTitle: "₹0 FUEL?!", metaDescription: "A bold claim that makes viewers curious about the real cost." },
  targetKeywords: ["ev charging"],
  brandTerms: [],
  knowledgePackActive: true,
};

describe("Module 7 Phase 7.4 — thumbnail scoring enrichment", () => {
  it("VIDEO_DIMENSION_V1 thumbnail-quality stays neutral (50) when no fresh Thumbnail Score is supplied", () => {
    const r = VIDEO_DIMENSION_V1.evaluate(baseVideo);
    const f = r.dimensionFactors.find((x) => x.id === "video-thumbnail-quality")!;
    expect(f.value).toBe(50);
    expect(f.reason).toMatch(/no fresh Thumbnail Score/i);
  });

  it("VIDEO_DIMENSION_V1 thumbnail-quality is a DERIVED READ of currentThumbnailScore when supplied", () => {
    const r = VIDEO_DIMENSION_V1.evaluate({ ...baseVideo, currentThumbnailScore: 87 });
    const f = r.dimensionFactors.find((x) => x.id === "video-thumbnail-quality")!;
    expect(f.value).toBe(87);
    expect(f.reason).toMatch(/Derived from the current/i);
  });

  it("VIDEO_DIMENSION_V1 output is byte-identical with currentThumbnailScore null vs absent", () => {
    const a = JSON.stringify(VIDEO_DIMENSION_V1.evaluate(baseVideo));
    const b = JSON.stringify(VIDEO_DIMENSION_V1.evaluate({ ...baseVideo, currentThumbnailScore: null }));
    expect(a).toEqual(b);
  });

  it("THUMBNAIL_DIMENSION_V1 adds ONLY truthful image factors when real image evidence is present", () => {
    const withoutImg = THUMBNAIL_DIMENSION_V1.evaluate(baseThumb);
    const withImg = THUMBNAIL_DIMENSION_V1.evaluate({ ...baseThumb, thumbnailImageEvidence: { present: true, width: 1536, height: 864, aspectRatioOk: true } });
    const newFactorIds = withImg.dimensionFactors.map((f) => f.id).filter((id) => !withoutImg.dimensionFactors.map((x) => x.id).includes(id));
    expect(newFactorIds.sort()).toEqual(["thumbnail-image-aspect-ratio", "thumbnail-image-dimensions", "thumbnail-image-present"]);
    // No fabricated CV claims.
    for (const f of withImg.dimensionFactors) {
      expect(f.label.toLowerCase()).not.toMatch(/facial|expression|emotion|contrast/);
    }
  });

  it("THUMBNAIL_DIMENSION_V1 output is byte-identical when image evidence is absent (Phase 7.3 unchanged)", () => {
    const a = JSON.stringify(THUMBNAIL_DIMENSION_V1.evaluate(baseThumb));
    const b = JSON.stringify(THUMBNAIL_DIMENSION_V1.evaluate({ ...baseThumb, thumbnailImageEvidence: undefined }));
    expect(a).toEqual(b);
  });

  it("low-resolution / wrong-aspect images score their objective factors low", () => {
    const r = THUMBNAIL_DIMENSION_V1.evaluate({ ...baseThumb, thumbnailImageEvidence: { present: true, width: 320, height: 180, aspectRatioOk: false } });
    expect(r.dimensionFactors.find((f) => f.id === "thumbnail-image-dimensions")!.value).toBeLessThan(50);
    expect(r.dimensionFactors.find((f) => f.id === "thumbnail-image-aspect-ratio")!.value).toBeLessThan(50);
  });
});
