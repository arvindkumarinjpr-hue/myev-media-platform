import type { PublishingExecutionCallbacks, PublishingPublishInput } from "../publishing-provider.interface";
import { YouTubeChannelProvider } from "./youtube-channel-provider";
import { startYouTubeFixtureServer, type YouTubeFixtureResponse as FixtureResponse, type YouTubeFixtureServer } from "./youtube-test-fixture-server";

const CLIENT = { oauthClientId: "client-id", oauthClientSecret: "client-secret" };
const CREDENTIAL = { accessToken: "access-token-1", refreshToken: "refresh-token-1" };
const VIDEO_BYTES_20 = Buffer.alloc(20, 7); // deterministic fixture "video" — small on purpose (Part Z: no real 2GB fixture needed).

function mediaReaderFor(bytes: Buffer): NonNullable<PublishingExecutionCallbacks["mediaReader"]> {
  return {
    headObject: async () => ({ sizeBytes: bytes.length, contentType: "video/mp4" }),
    readRange: async (_id, start, end) => bytes.subarray(start, end + 1),
  };
}

function callbacksWithCheckpoint(mediaReader: NonNullable<PublishingExecutionCallbacks["mediaReader"]>) {
  let saved: Record<string, unknown> | undefined;
  const callbacks: PublishingExecutionCallbacks = {
    saveCheckpoint: async (detail) => {
      saved = detail;
    },
    mediaReader,
  };
  return { callbacks, getSaved: () => saved };
}

const BASE_INPUT: PublishingPublishInput = {
  contentType: "VIDEO",
  metadata: { title: "A Great Video", description: "A short description.", tags: ["tag1", "tag2"] },
  artifact: { mediaAssetPublicId: "asset-1" },
  operationToken: "publishing:target-3:attempt:0",
};

function sessionLocation(server: YouTubeFixtureServer, id: string): string {
  return `${server.url}/upload/session/${id}`;
}

describe("YouTubeChannelProvider — resumable upload (Part AC)", () => {
  let server: YouTubeFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("creates a resumable upload session with the correct snippet/status payload and X-Upload-Content-* headers", async () => {
    server = await startYouTubeFixtureServer((req) => {
      if (req.path.startsWith("/videos?uploadType=resumable")) {
        return { status: 200, headers: { Location: sessionLocation(server!, "s1") } };
      }
      if (req.path === "/upload/session/s1") return { status: 201, json: { id: "vid123", snippet: { title: "A Great Video" } } };
      return { status: 500, json: {} };
    });
    const provider = new YouTubeChannelProvider({ ...CLIENT, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES_20));

    const result = await provider.publish(BASE_INPUT, CREDENTIAL, callbacks);

    expect(result).toEqual({ externalContentId: "vid123", externalUrl: "https://www.youtube.com/watch?v=vid123" });
    const createReq = server.requests.find((r) => r.path.startsWith("/videos?uploadType=resumable"))!;
    expect(createReq.headers["x-upload-content-length"]).toBe("20");
    expect(createReq.headers["x-upload-content-type"]).toBe("video/mp4");
    expect(createReq.body).toEqual({ snippet: { title: "A Great Video", description: "A short description.", tags: ["tag1", "tag2"] }, status: { privacyStatus: "PRIVATE" } });
  });

  it("defaults privacyStatus to PRIVATE when metadata.privacy is omitted, and uses the explicit value when set", async () => {
    server = await startYouTubeFixtureServer((req) => {
      if (req.path.startsWith("/videos?uploadType=resumable")) return { status: 200, headers: { Location: sessionLocation(server!, "s1") } };
      return { status: 201, json: { id: "vid1" } };
    });
    const provider = new YouTubeChannelProvider({ ...CLIENT, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES_20));
    await provider.publish({ ...BASE_INPUT, metadata: { ...BASE_INPUT.metadata, privacy: "UNLISTED" } }, CREDENTIAL, callbacks);
    const createReq = server.requests.find((r) => r.path.startsWith("/videos?uploadType=resumable"))!;
    expect((createReq.body as { status: { privacyStatus: string } }).status.privacyStatus).toBe("UNLISTED");
  });

  it("never sends tags when Module 7 produced none, rather than inventing any", async () => {
    server = await startYouTubeFixtureServer((req) => {
      if (req.path.startsWith("/videos?uploadType=resumable")) return { status: 200, headers: { Location: sessionLocation(server!, "s1") } };
      return { status: 201, json: { id: "vid1" } };
    });
    const provider = new YouTubeChannelProvider({ ...CLIENT, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES_20));
    await provider.publish({ ...BASE_INPUT, metadata: { title: "T" } }, CREDENTIAL, callbacks);
    const createReq = server.requests.find((r) => r.path.startsWith("/videos?uploadType=resumable"))!;
    expect((createReq.body as { snippet: Record<string, unknown> }).snippet).not.toHaveProperty("tags");
    expect((createReq.body as { snippet: Record<string, unknown> }).snippet).not.toHaveProperty("description");
  });

  it("saves a checkpoint with the session URI BEFORE uploading a single byte", async () => {
    let checkpointSavedBeforeUpload = false;
    server = await startYouTubeFixtureServer((req) => {
      if (req.path.startsWith("/videos?uploadType=resumable")) return { status: 200, headers: { Location: sessionLocation(server!, "s1") } };
      if (req.path === "/upload/session/s1") {
        // By the time ANY byte-upload request reaches the fixture, the checkpoint must already have been saved.
        expect(checkpointSavedBeforeUpload).toBe(true);
        return { status: 201, json: { id: "vid1" } };
      }
      return { status: 500, json: {} };
    });
    const provider = new YouTubeChannelProvider({ ...CLIENT, uploadBaseUrl: server.url });
    const mediaReader = mediaReaderFor(VIDEO_BYTES_20);
    const callbacks: PublishingExecutionCallbacks = {
      saveCheckpoint: async (detail) => {
        expect(detail).toMatchObject({ uploadSessionUri: sessionLocation(server!, "s1"), totalBytes: 20 });
        checkpointSavedBeforeUpload = true;
      },
      mediaReader,
    };
    await provider.publish(BASE_INPUT, CREDENTIAL, callbacks);
    expect(checkpointSavedBeforeUpload).toBe(true);
  });

  it("uploads a multi-chunk video across exactly the expected PUT calls with correct Content-Range headers, advancing on 308", async () => {
    server = await startYouTubeFixtureServer((req): FixtureResponse => {
      if (req.path.startsWith("/videos?uploadType=resumable")) return { status: 200, headers: { Location: sessionLocation(server!, "s1") } };
      if (req.path === "/upload/session/s1") {
        const contentRange = req.headers["content-range"] as string;
        if (contentRange === "bytes 0-6/20") return { status: 308, headers: { Range: "bytes=0-6" } };
        if (contentRange === "bytes 7-13/20") return { status: 308, headers: { Range: "bytes=0-13" } };
        if (contentRange === "bytes 14-19/20") return { status: 201, json: { id: "vid-multi" } };
        return { status: 500, json: { unexpected: contentRange } };
      }
      return { status: 500, json: {} };
    });
    const provider = new YouTubeChannelProvider({ ...CLIENT, uploadBaseUrl: server.url, chunkSizeBytes: 7 });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES_20));

    const result = await provider.publish(BASE_INPUT, CREDENTIAL, callbacks);

    expect(result.externalContentId).toBe("vid-multi");
    const uploadReqs = server.requests.filter((r) => r.path === "/upload/session/s1");
    expect(uploadReqs).toHaveLength(3);
    expect(uploadReqs.map((r) => r.headers["content-range"])).toEqual(["bytes 0-6/20", "bytes 7-13/20", "bytes 14-19/20"]);
    // Each chunk's actual body bytes match the corresponding slice of the source "video".
    expect(uploadReqs[0].body).toEqual(VIDEO_BYTES_20.subarray(0, 7));
    expect(uploadReqs[1].body).toEqual(VIDEO_BYTES_20.subarray(7, 14));
    expect(uploadReqs[2].body).toEqual(VIDEO_BYTES_20.subarray(14, 20));
  });
});

describe("YouTubeChannelProvider — crash/reconciliation (Part U/V/AE, mandatory)", () => {
  let server: YouTubeFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("a retry that finds the upload STILL incomplete resumes from the reported offset — no second session is ever created", async () => {
    let sessionCreateCalls = 0;
    server = await startYouTubeFixtureServer((req): FixtureResponse => {
      if (req.path.startsWith("/videos?uploadType=resumable")) {
        sessionCreateCalls += 1;
        return { status: 200, headers: { Location: sessionLocation(server!, "s1") } };
      }
      if (req.path === "/upload/session/s1") {
        const contentRange = req.headers["content-range"] as string;
        // Status-check (Part U's own officially-documented mechanism): empty body, "bytes */20".
        if (contentRange === "bytes */20") return { status: 308, headers: { Range: "bytes=0-9" } }; // 10 of 20 bytes already received.
        if (contentRange === "bytes 10-19/20") return { status: 201, json: { id: "vid-resumed" } };
        return { status: 500, json: { unexpected: contentRange } };
      }
      return { status: 500, json: {} };
    });
    const provider = new YouTubeChannelProvider({ ...CLIENT, uploadBaseUrl: server.url });
    const mediaReader = mediaReaderFor(VIDEO_BYTES_20);

    // Simulates a redelivered/retried attempt for the SAME target: the
    // checkpoint from an earlier (crashed) attempt is supplied via
    // priorCheckpoint, exactly as PublishingExecutionService would.
    const result = await provider.publish(
      { ...BASE_INPUT, priorCheckpoint: { uploadSessionUri: sessionLocation(server, "s1"), totalBytes: 20 } },
      CREDENTIAL,
      { saveCheckpoint: async () => {}, mediaReader },
    );

    expect(result).toEqual({ externalContentId: "vid-resumed", externalUrl: "https://www.youtube.com/watch?v=vid-resumed" });
    expect(sessionCreateCalls).toBe(0); // the critical assertion: NO new session was ever created.
    const uploadReqs = server.requests.filter((r) => r.path === "/upload/session/s1");
    // status-check, then exactly the REMAINING bytes — never re-uploads bytes 0-9.
    expect(uploadReqs).toHaveLength(2);
    expect(uploadReqs[1].body).toEqual(VIDEO_BYTES_20.subarray(10, 20));
  });

  it("THE mandatory proof: the upload actually completed on YouTube's side before MYEV crashed — a retry discovers the ALREADY-CREATED video via the status-check and creates NO second video", async () => {
    let sessionCreateCalls = 0;
    let uploadPutCallsWithBody = 0;
    server = await startYouTubeFixtureServer((req) => {
      if (req.path.startsWith("/videos?uploadType=resumable")) {
        sessionCreateCalls += 1;
        return { status: 200, headers: { Location: sessionLocation(server!, "s1") } };
      }
      if (req.path === "/upload/session/s1") {
        const contentRange = req.headers["content-range"] as string;
        // The status-check for an ALREADY-COMPLETED upload: per Google's
        // own resumable-upload guide, the server "returns the same
        // response that it sent when the upload originally completed" —
        // simulated here directly, since from MYEV's perspective this
        // upload completing was never observed (the "crash").
        if (contentRange === "bytes */20") return { status: 201, json: { id: "vid-already-done" } };
        // Any actual byte upload here would be the bug under test.
        uploadPutCallsWithBody += 1;
        return { status: 500, json: { message: "should never be reached" } };
      }
      return { status: 500, json: {} };
    });
    const provider = new YouTubeChannelProvider({ ...CLIENT, uploadBaseUrl: server.url });
    const mediaReader = mediaReaderFor(VIDEO_BYTES_20);

    const result = await provider.publish(
      { ...BASE_INPUT, priorCheckpoint: { uploadSessionUri: sessionLocation(server, "s1"), totalBytes: 20 } },
      CREDENTIAL,
      { saveCheckpoint: async () => {}, mediaReader },
    );

    expect(result).toEqual({ externalContentId: "vid-already-done", externalUrl: "https://www.youtube.com/watch?v=vid-already-done" });
    expect(sessionCreateCalls).toBe(0); // no second session/upload was ever started.
    expect(uploadPutCallsWithBody).toBe(0); // no bytes were ever re-uploaded.
    const uploadReqs = server.requests.filter((r) => r.path === "/upload/session/s1");
    expect(uploadReqs).toHaveLength(1); // exactly one status-check, nothing else.
  });

  it("an expired session (404 on status-check) is the one case where starting a brand-new session is safe, and does start one", async () => {
    let sessionCreateCalls = 0;
    server = await startYouTubeFixtureServer((req) => {
      if (req.path.startsWith("/videos?uploadType=resumable")) {
        sessionCreateCalls += 1;
        return { status: 200, headers: { Location: sessionLocation(server!, "s2") } };
      }
      if (req.path === "/upload/session/s1") return { status: 404, json: { error: { message: "session not found" } } }; // the OLD, expired session.
      if (req.path === "/upload/session/s2") return { status: 201, json: { id: "vid-fresh" } };
      return { status: 500, json: {} };
    });
    const provider = new YouTubeChannelProvider({ ...CLIENT, uploadBaseUrl: server.url });
    const mediaReader = mediaReaderFor(VIDEO_BYTES_20);

    const result = await provider.publish(
      { ...BASE_INPUT, priorCheckpoint: { uploadSessionUri: sessionLocation(server, "s1"), totalBytes: 20 } },
      CREDENTIAL,
      { saveCheckpoint: async () => {}, mediaReader },
    );

    expect(result.externalContentId).toBe("vid-fresh");
    expect(sessionCreateCalls).toBe(1); // exactly one NEW session, only after the old one was conclusively found gone.
  });

  it("a transient failure right after the checkpoint was saved (before any byte uploaded) still leaves the checkpoint resumable on the next attempt — no second session is created", async () => {
    let sessionCreateCalls = 0;
    let chunkAttempts = 0;
    server = await startYouTubeFixtureServer((req): FixtureResponse => {
      if (req.path.startsWith("/videos?uploadType=resumable")) {
        sessionCreateCalls += 1;
        return { status: 200, headers: { Location: sessionLocation(server!, "s1") } };
      }
      if (req.path === "/upload/session/s1") {
        const contentRange = req.headers["content-range"] as string;
        if (contentRange === "bytes */20") return { status: 308, headers: { Range: "" } }; // status-check on retry: nothing received yet.
        if (contentRange === "bytes 0-19/20") {
          chunkAttempts += 1;
          // First real chunk attempt fails transiently (simulating a
          // crash/network blip right after the checkpoint was saved);
          // the second (from the retried attempt, after a status-check)
          // succeeds.
          if (chunkAttempts === 1) return { status: 503, json: { error: { message: "transient" } } };
          return { status: 201, json: { id: "vid-after-retry" } };
        }
        return { status: 500, json: { unexpected: contentRange } };
      }
      return { status: 500, json: {} };
    });
    const provider = new YouTubeChannelProvider({ ...CLIENT, uploadBaseUrl: server.url });
    const mediaReader = mediaReaderFor(VIDEO_BYTES_20);
    let savedCheckpoint: Record<string, unknown> | undefined;

    // Attempt 1: fails transiently on the chunk upload — this is the
    // real Part S "resumable-upload transient interruption" case, always
    // retryable, and the checkpoint was already saved before this failure.
    await expect(
      provider.publish(BASE_INPUT, CREDENTIAL, {
        saveCheckpoint: async (detail) => {
          savedCheckpoint = detail;
        },
        mediaReader,
      }),
    ).rejects.toThrow();
    expect(savedCheckpoint).toBeDefined();
    expect(sessionCreateCalls).toBe(1);

    // Attempt 2 (the outer Phase 9.3 retry system re-invoking publish()
    // with the SAME target's saved checkpoint): resumes via status-check
    // — no new session is created.
    const result = await provider.publish({ ...BASE_INPUT, priorCheckpoint: savedCheckpoint }, CREDENTIAL, { saveCheckpoint: async () => {}, mediaReader });

    expect(result.externalContentId).toBe("vid-after-retry");
    expect(sessionCreateCalls).toBe(1); // still exactly one — the retry never created a second session.
  });
});
