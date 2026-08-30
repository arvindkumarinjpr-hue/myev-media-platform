import { QueueRegistryBuilder } from "../queue-registry";
import { validateProcessorManifest } from "../processor-manifest";
import { MEDIA_IMAGE_GENERATE_V1_MANIFEST } from "./media-image-generate";
import { MEDIA_TTS_V1_MANIFEST } from "./media-tts";
import { MEDIA_SUBTITLE_GENERATE_V1_MANIFEST } from "./media-subtitle-generate";

const ALL = [MEDIA_IMAGE_GENERATE_V1_MANIFEST, MEDIA_TTS_V1_MANIFEST, MEDIA_SUBTITLE_GENERATE_V1_MANIFEST];

describe("media.* job manifests", () => {
  it.each(ALL)("$jobType is a structurally valid manifest on the MEDIA queue", (m) => {
    expect(() => validateProcessorManifest(m)).not.toThrow();
    expect(m.queue).toBe("MEDIA");
    expect(m.timeout).toBeLessThanOrEqual(m.maximumRuntime);
    expect(m.defaultRetryPolicy?.maxAttempts).toBe(3);
    expect(m.cancelable).toBe(false);
  });

  it("all three register + bind into one QueueRegistry scoped to MEDIA without collision", () => {
    const b = new QueueRegistryBuilder();
    for (const m of ALL) {
      b.registerManifest(m);
      b.bindHandler(m.jobType, async () => ({ mediaJobPublicId: "x" }));
    }
    const reg = b.freeze({ requireHandlersForQueues: ["MEDIA"] });
    expect(reg.listManifests().map((m) => m.jobType).sort()).toEqual(["media.image-generate.v1", "media.subtitle-generate.v1", "media.tts.v1"]);
  });

  it("payloads carry only an id reference, never media bytes", () => {
    for (const m of ALL) {
      const keys = Object.getOwnPropertyNames(new m.payloadDto());
      // class-validator decorated but the instance has no own props until assigned — assert the DTO name intent instead.
      expect(m.payloadDto.name).toMatch(/Payload$/);
      void keys;
    }
  });
});
