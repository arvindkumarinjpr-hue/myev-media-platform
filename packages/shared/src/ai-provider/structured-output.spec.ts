import "reflect-metadata";
import { IsInt, IsString, Min } from "class-validator";
import { AIProviderError, AIProviderErrorCode } from "./ai-provider-error";
import { parseStructuredOutput } from "./structured-output";

class BlogOutlineDto {
  @IsString()
  title!: string;

  @IsInt()
  @Min(1)
  sectionCount!: number;
}

describe("parseStructuredOutput", () => {
  it("parses and validates well-formed JSON matching the schema", async () => {
    const result = await parseStructuredOutput(JSON.stringify({ title: "EV Charging 101", sectionCount: 5 }), BlogOutlineDto, "fake");
    expect(result).toBeInstanceOf(BlogOutlineDto);
    expect(result.title).toBe("EV Charging 101");
    expect(result.sectionCount).toBe(5);
  });

  it("throws a normalized MALFORMED_STRUCTURED_OUTPUT error when the text is not valid JSON", async () => {
    await expect(parseStructuredOutput("not json at all {", BlogOutlineDto, "fake")).rejects.toMatchObject({
      code: AIProviderErrorCode.MALFORMED_STRUCTURED_OUTPUT,
      provider: "fake",
    });
  });

  it("throws a normalized error when the JSON parses but is an array, not an object", async () => {
    await expect(parseStructuredOutput("[1,2,3]", BlogOutlineDto, "fake")).rejects.toBeInstanceOf(AIProviderError);
  });

  it("throws a normalized error when the JSON parses but is a primitive, not an object", async () => {
    await expect(parseStructuredOutput("42", BlogOutlineDto, "fake")).rejects.toMatchObject({ code: AIProviderErrorCode.MALFORMED_STRUCTURED_OUTPUT });
  });

  it("throws a normalized error when the object shape violates the schema's own validators", async () => {
    await expect(parseStructuredOutput(JSON.stringify({ title: "ok", sectionCount: -3 }), BlogOutlineDto, "fake")).rejects.toMatchObject({
      code: AIProviderErrorCode.MALFORMED_STRUCTURED_OUTPUT,
    });
  });

  it("throws a normalized error when a required field is missing", async () => {
    await expect(parseStructuredOutput(JSON.stringify({ title: "ok" }), BlogOutlineDto, "fake")).rejects.toBeInstanceOf(AIProviderError);
  });

  it("never leaks the raw provider text into the safe error message on failure", async () => {
    const secretLookingText = "sk-super-secret-not-json";
    try {
      await parseStructuredOutput(secretLookingText, BlogOutlineDto, "fake");
      throw new Error("expected parseStructuredOutput to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AIProviderError);
      expect((err as AIProviderError).messageSafe).not.toContain(secretLookingText);
    }
  });
});
