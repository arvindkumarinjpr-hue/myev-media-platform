import { S3Client, CreateBucketCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { MediaStorageService } from "./media-storage.service";

type StorageCfg = {
  endpoint: string;
  port: number;
  useSsl: boolean;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
  providerIdentity: string;
  autoCreateBucket: boolean;
};

function makeService(overrides: Partial<StorageCfg> = {}): MediaStorageService {
  const storage: StorageCfg = {
    endpoint: "localhost",
    port: 9000,
    useSsl: false,
    region: "us-east-1",
    bucket: "media-test",
    accessKey: "ak",
    secretKey: "sk",
    forcePathStyle: true,
    providerIdentity: "MINIO",
    autoCreateBucket: true,
    ...overrides,
  };
  const config = { get: () => storage } as unknown as ConstructorParameters<typeof MediaStorageService>[0];
  return new MediaStorageService(config);
}

describe("MediaStorageService (official @aws-sdk/client-s3)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("onModuleInit: HeadBucket succeeds → never attempts CreateBucket", async () => {
    const send = jest.spyOn(S3Client.prototype, "send").mockResolvedValue({} as never);
    await makeService().onModuleInit();
    const commands = send.mock.calls.map((c) => c[0].constructor.name);
    expect(commands).toEqual(["HeadBucketCommand"]);
  });

  it("onModuleInit: bucket missing + autoCreate enabled → creates it", async () => {
    const send = jest.spyOn(S3Client.prototype, "send").mockImplementation((cmd) => {
      if (cmd instanceof HeadBucketCommand) return Promise.reject(Object.assign(new Error("nf"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }));
      return Promise.resolve({} as never);
    });
    await makeService().onModuleInit();
    expect(send.mock.calls.map((c) => c[0].constructor.name)).toEqual(["HeadBucketCommand", "CreateBucketCommand"]);
  });

  it("onModuleInit: bucket missing + autoCreate DISABLED → does NOT create it (production S3/R2)", async () => {
    const send = jest.spyOn(S3Client.prototype, "send").mockImplementation((cmd) => {
      if (cmd instanceof HeadBucketCommand) return Promise.reject(Object.assign(new Error("nf"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }));
      return Promise.resolve({} as never);
    });
    await makeService({ autoCreateBucket: false }).onModuleInit();
    expect(send.mock.calls.some((c) => c[0] instanceof CreateBucketCommand)).toBe(false);
  });

  it("onModuleInit: a permission failure (403) never triggers a create attempt", async () => {
    const send = jest.spyOn(S3Client.prototype, "send").mockImplementation((cmd) => {
      if (cmd instanceof HeadBucketCommand) return Promise.reject(Object.assign(new Error("forbidden"), { name: "Forbidden", $metadata: { httpStatusCode: 403 } }));
      return Promise.resolve({} as never);
    });
    await makeService().onModuleInit();
    expect(send.mock.calls.some((c) => c[0] instanceof CreateBucketCommand)).toBe(false);
  });

  it("put: sends a PutObjectCommand with the bucket, key (spaces/special chars preserved) and content type", async () => {
    const send = jest.spyOn(S3Client.prototype, "send").mockResolvedValue({} as never);
    const key = "workspaces/w s/projects/p&p/image/id 1/1/scene one (final).png";
    await makeService().put(key, Buffer.from("bytes"), "image/png");
    const cmd = send.mock.calls[0][0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({ Bucket: "media-test", Key: key, ContentType: "image/png" });
  });

  it("getText: reads the object body stream to a UTF-8 string", async () => {
    jest.spyOn(S3Client.prototype, "send").mockImplementation((cmd) => {
      expect(cmd).toBeInstanceOf(GetObjectCommand);
      return Promise.resolve({ Body: Readable.from([Buffer.from('{"durationMs":1000}')]) } as never);
    });
    expect(await makeService().getText("k/timings.json")).toBe('{"durationMs":1000}');
  });

  describe("headObject — Module 9 Phase 9.5 (Publishing/YouTube-scoped enabling change)", () => {
    it("sends a HeadObjectCommand and returns size/content-type without reading any bytes", async () => {
      const send = jest.spyOn(S3Client.prototype, "send").mockResolvedValue({ ContentLength: 123_456, ContentType: "video/mp4" } as never);
      const result = await makeService().headObject("k/video.mp4");
      expect(result).toEqual({ sizeBytes: 123_456, contentType: "video/mp4" });
      const cmd = send.mock.calls[0][0] as HeadObjectCommand;
      expect(cmd).toBeInstanceOf(HeadObjectCommand);
      expect(cmd.input).toMatchObject({ Bucket: "media-test", Key: "k/video.mp4" });
    });

    it("throws if the object reports no Content-Length", async () => {
      jest.spyOn(S3Client.prototype, "send").mockResolvedValue({} as never);
      await expect(makeService().headObject("k/video.mp4")).rejects.toThrow(/Content-Length/);
    });

    it("propagates a missing-object error rather than silently returning a fake result", async () => {
      jest.spyOn(S3Client.prototype, "send").mockImplementation(() => Promise.reject(Object.assign(new Error("not found"), { name: "NotFound", $metadata: { httpStatusCode: 404 } })));
      await expect(makeService().headObject("k/missing.mp4")).rejects.toThrow("not found");
    });
  });

  describe("getRange — Module 9 Phase 9.5 (Publishing/YouTube-scoped enabling change)", () => {
    it("sends a GetObjectCommand with the exact Range header for the requested byte range", async () => {
      const send = jest.spyOn(S3Client.prototype, "send").mockResolvedValue({ Body: Readable.from([Buffer.alloc(10, 7)]) } as never);
      await makeService().getRange("k/video.mp4", 0, 9);
      const cmd = send.mock.calls[0][0] as GetObjectCommand;
      expect(cmd).toBeInstanceOf(GetObjectCommand);
      expect(cmd.input).toMatchObject({ Bucket: "media-test", Key: "k/video.mp4", Range: "bytes=0-9" });
    });

    it("returns exactly the requested chunk, never more — proving one call never buffers beyond its own range", async () => {
      const chunk = Buffer.from("0123456789");
      jest.spyOn(S3Client.prototype, "send").mockResolvedValue({ Body: Readable.from([chunk]) } as never);
      const result = await makeService().getRange("k/video.mp4", 100, 109);
      expect(result).toEqual(chunk);
      expect(result.length).toBe(10);
    });

    it("a second range read for the same object is an entirely independent call (retrying/advancing a chunk never re-reads the full object)", async () => {
      const send = jest
        .spyOn(S3Client.prototype, "send")
        .mockResolvedValueOnce({ Body: Readable.from([Buffer.alloc(5, 1)]) } as never)
        .mockResolvedValueOnce({ Body: Readable.from([Buffer.alloc(5, 2)]) } as never);
      const service = makeService();
      const first = await service.getRange("k/video.mp4", 0, 4);
      const second = await service.getRange("k/video.mp4", 5, 9);
      expect(first).toEqual(Buffer.alloc(5, 1));
      expect(second).toEqual(Buffer.alloc(5, 2));
      expect(send).toHaveBeenCalledTimes(2);
      expect((send.mock.calls[0][0] as GetObjectCommand).input.Range).toBe("bytes=0-4");
      expect((send.mock.calls[1][0] as GetObjectCommand).input.Range).toBe("bytes=5-9");
    });

    it("rejects an invalid range (end before start) without ever calling the storage backend", async () => {
      const send = jest.spyOn(S3Client.prototype, "send");
      await expect(makeService().getRange("k/video.mp4", 10, 5)).rejects.toThrow(/invalid range/i);
      expect(send).not.toHaveBeenCalled();
    });

    it("rejects a negative start without ever calling the storage backend", async () => {
      const send = jest.spyOn(S3Client.prototype, "send");
      await expect(makeService().getRange("k/video.mp4", -1, 5)).rejects.toThrow(/invalid range/i);
      expect(send).not.toHaveBeenCalled();
    });

    it("throws on a short/truncated read — fewer bytes returned than the requested range implies is never silently accepted", async () => {
      jest.spyOn(S3Client.prototype, "send").mockResolvedValue({ Body: Readable.from([Buffer.alloc(3, 9)]) } as never);
      await expect(makeService().getRange("k/video.mp4", 0, 9)).rejects.toThrow(/returned 3 bytes/);
    });

    it("throws when the object has no body", async () => {
      jest.spyOn(S3Client.prototype, "send").mockResolvedValue({} as never);
      await expect(makeService().getRange("k/video.mp4", 0, 9)).rejects.toThrow(/no body/);
    });

    it("propagates a missing-object error safely", async () => {
      jest.spyOn(S3Client.prototype, "send").mockImplementation(() => Promise.reject(Object.assign(new Error("no such key"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } })));
      await expect(makeService().getRange("k/missing.mp4", 0, 9)).rejects.toThrow("no such key");
    });
  });

  it("existing getBytes()/getText()/put() consumers are unaffected by the new headObject/getRange methods", async () => {
    const send = jest.spyOn(S3Client.prototype, "send").mockResolvedValue({ Body: Readable.from([Buffer.from("hello")]), ContentLength: 5 } as never);
    const service = makeService();
    expect(await service.getBytes("k", 1024)).toEqual(Buffer.from("hello"));
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
  });
});
