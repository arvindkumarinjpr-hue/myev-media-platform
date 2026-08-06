import "reflect-metadata";
import { validateProcessorManifest } from "../processor-manifest";
import { SYSTEM_PING_V1_MANIFEST } from "./system-ping";

describe("SYSTEM_PING_V1_MANIFEST", () => {
  it("is a well-formed ProcessorManifest", () => {
    expect(() => validateProcessorManifest(SYSTEM_PING_V1_MANIFEST)).not.toThrow();
  });
});
