import { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
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
});
