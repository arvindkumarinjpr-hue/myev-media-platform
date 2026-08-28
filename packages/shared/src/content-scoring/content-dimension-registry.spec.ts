import { ContentDimensionRegistryBuilder, ContentDimensionRegistryError } from "./content-dimension-registry";
import { BLOG_DIMENSION_V1 } from "./dimensions/blog-dimension";
import { makeSyntheticDimension } from "./testing/synthetic-dimension";

describe("ContentDimensionRegistry", () => {
  it("registers, freezes, and resolves by name (latest version by default)", () => {
    const reg = new ContentDimensionRegistryBuilder()
      .register(makeSyntheticDimension({ name: "x", version: 1 }))
      .register(makeSyntheticDimension({ name: "x", version: 3 }))
      .register(makeSyntheticDimension({ name: "x", version: 2 }))
      .freeze();
    expect(reg.resolve("x").version).toBe(3);
    expect(reg.resolve("x", 2).version).toBe(2);
    expect(reg.has("x")).toBe(true);
    expect(reg.has("x", 9)).toBe(false);
  });

  it("resolves a dimension for a ContentType", () => {
    const reg = new ContentDimensionRegistryBuilder().register(BLOG_DIMENSION_V1).freeze();
    expect(reg.resolveForContentType("BLOG").name).toBe("blog");
    expect(reg.hasContentType("BLOG")).toBe(true);
    expect(reg.hasContentType("VIDEO")).toBe(false);
    expect(() => reg.resolveForContentType("VIDEO")).toThrow(ContentDimensionRegistryError);
  });

  it("rejects duplicate name@version registration", () => {
    const b = new ContentDimensionRegistryBuilder().register(makeSyntheticDimension({ name: "dup", version: 1 }));
    expect(() => b.register(makeSyntheticDimension({ name: "dup", version: 1 }))).toThrow(/duplicate dimension registration/);
  });

  it("rejects registration after freeze", () => {
    const b = new ContentDimensionRegistryBuilder();
    b.freeze();
    expect(() => b.register(makeSyntheticDimension())).toThrow(/already frozen/);
    expect(() => b.freeze()).toThrow(/already frozen/);
  });

  it("rejects malformed dimensions", () => {
    const b = new ContentDimensionRegistryBuilder();
    expect(() => b.register(makeSyntheticDimension({ name: "Bad-Caps" }))).toThrow(/lowercase/);
    expect(() => b.register(makeSyntheticDimension({ version: 0 }))).toThrow(/positive integer version/);
    expect(() => b.register(makeSyntheticDimension({ appliesTo: [] }))).toThrow(/at least one contentType/);
  });

  it("flags ambiguity when two dimensions claim the same ContentType", () => {
    const reg = new ContentDimensionRegistryBuilder()
      .register(makeSyntheticDimension({ name: "a", appliesTo: ["PODCAST"] }))
      .register(makeSyntheticDimension({ name: "b", appliesTo: ["PODCAST"] }))
      .freeze();
    expect(() => reg.resolveForContentType("PODCAST")).toThrow(/ambiguous/);
  });

  it("only 'blog' is registered when the production Blog dimension stands alone (no Video/Thumbnail yet)", () => {
    const reg = new ContentDimensionRegistryBuilder().register(BLOG_DIMENSION_V1).freeze();
    expect(reg.registeredNames()).toEqual(["blog"]);
  });
});
