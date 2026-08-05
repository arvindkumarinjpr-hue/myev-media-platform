import { getWorkerConfig, MissingRedisUrlError } from "./config";

describe("getWorkerConfig", () => {
  it("throws MissingRedisUrlError when REDIS_URL is absent", () => {
    expect(() => getWorkerConfig({})).toThrow(MissingRedisUrlError);
  });

  it("returns the redis URL and defaults log level to info", () => {
    const config = getWorkerConfig({ REDIS_URL: "redis://redis:6379" });
    expect(config.redisUrl).toBe("redis://redis:6379");
    expect(config.logLevel).toBe("info");
  });

  it("respects an explicit LOG_LEVEL", () => {
    const config = getWorkerConfig({ REDIS_URL: "redis://redis:6379", LOG_LEVEL: "debug" });
    expect(config.logLevel).toBe("debug");
  });
});
