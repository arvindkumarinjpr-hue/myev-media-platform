import type { ConfigService } from "@nestjs/config";
import { AdaptiveProtectionService } from "./adaptive-protection.service";

// Module 1B.1 Engineering Plan, Refinement 1: Redis outages must degrade to
// an in-process fallback, never to "no protection." These tests drive a
// mocked ioredis client through a healthy -> failing -> recovered cycle and
// assert the fallback keeps enforcing the same threshold/window semantics.

const redisMock = {
  incr: jest.fn(),
  expire: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
  ttl: jest.fn(),
  ping: jest.fn(),
  on: jest.fn(),
  disconnect: jest.fn(),
};

jest.mock("ioredis", () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => redisMock),
  };
});

function makeConfig(): ConfigService<import("../../config/configuration").AppConfig, true> {
  return { get: () => "redis://fake-host:6379" } as unknown as ConfigService<
    import("../../config/configuration").AppConfig,
    true
  >;
}

describe("AdaptiveProtectionService", () => {
  let service: AdaptiveProtectionService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    service = new AdaptiveProtectionService(makeConfig());
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    jest.useRealTimers();
  });

  describe("while Redis is healthy", () => {
    it("uses the Redis-backed counter and reports locked once the threshold is reached", async () => {
      redisMock.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(5);
      redisMock.expire.mockResolvedValue("OK");

      const first = await service.recordFailedAttempt("user@example.com", 5, 900);
      expect(first.locked).toBe(false);
      expect(redisMock.expire).toHaveBeenCalledWith("login:failed:user@example.com", 900);

      const fifth = await service.recordFailedAttempt("user@example.com", 5, 900);
      expect(fifth.locked).toBe(true);
      expect(service.isRedisAvailable()).toBe(true);
    });

    it("does not degrade when Redis calls succeed", async () => {
      redisMock.incr.mockResolvedValue(1);
      redisMock.expire.mockResolvedValue("OK");
      await service.checkRateLimit("login:1.2.3.4", 10, 60);
      expect(service.isRedisAvailable()).toBe(true);
    });
  });

  describe("when Redis becomes unavailable", () => {
    it("still allows the operation to proceed via the in-memory fallback instead of failing closed or open", async () => {
      redisMock.incr.mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await service.recordFailedAttempt("user@example.com", 5, 900);

      // Falls through to the in-memory counter — protection continues,
      // it is not silently disabled.
      expect(result).toEqual({ locked: false, attempts: 1 });
      expect(service.isRedisAvailable()).toBe(false);
    });

    it("logs exactly one HIGH-severity degradation alert across many failures, not one per request", async () => {
      redisMock.incr.mockRejectedValue(new Error("ECONNREFUSED"));
      const errorSpy = jest.spyOn((service as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, "error");

      await service.recordFailedAttempt("a@example.com", 5, 900);
      await service.recordFailedAttempt("b@example.com", 5, 900);
      await service.recordFailedAttempt("c@example.com", 5, 900);

      const degradationAlerts = errorSpy.mock.calls.filter(
        ([entry]) => (entry as { event?: string }).event === "REDIS_PROTECTION_DEGRADED",
      );
      expect(degradationAlerts).toHaveLength(1);
    });

    it("keeps enforcing the same threshold via the fallback counter", async () => {
      redisMock.incr.mockRejectedValue(new Error("ECONNREFUSED"));

      for (let i = 0; i < 4; i++) {
         
        await service.recordFailedAttempt("user@example.com", 5, 900);
      }
      const fifth = await service.recordFailedAttempt("user@example.com", 5, 900);
      expect(fifth).toEqual({ locked: true, attempts: 5 });
    });

    it("continues enforcing rate limits via the in-memory fallback", async () => {
      redisMock.incr.mockRejectedValue(new Error("ECONNREFUSED"));

      for (let i = 0; i < 3; i++) {
         
        const result = await service.checkRateLimit("ip:1.2.3.4", 3, 60);
        expect(result.allowed).toBe(true);
      }
      const fourth = await service.checkRateLimit("ip:1.2.3.4", 3, 60);
      expect(fourth.allowed).toBe(false);
      expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  describe("recovery", () => {
    it("automatically switches back to Redis once it becomes reachable again", async () => {
      redisMock.incr.mockRejectedValue(new Error("ECONNREFUSED"));
      await service.recordFailedAttempt("user@example.com", 5, 900);
      expect(service.isRedisAvailable()).toBe(false);

      redisMock.ping.mockResolvedValue("PONG");
      await jest.advanceTimersByTimeAsync(5000);

      expect(service.isRedisAvailable()).toBe(true);
    });

    it("resumes logging degradation alerts if Redis fails again after recovering", async () => {
      redisMock.incr.mockRejectedValue(new Error("ECONNREFUSED"));
      await service.recordFailedAttempt("user@example.com", 5, 900);

      redisMock.ping.mockResolvedValue("PONG");
      await jest.advanceTimersByTimeAsync(5000);
      expect(service.isRedisAvailable()).toBe(true);

      redisMock.incr.mockRejectedValue(new Error("ECONNREFUSED again"));
      const errorSpy = jest.spyOn((service as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, "error");
      await service.recordFailedAttempt("user@example.com", 5, 900);

      const degradationAlerts = errorSpy.mock.calls.filter(
        ([entry]) => (entry as { event?: string }).event === "REDIS_PROTECTION_DEGRADED",
      );
      expect(degradationAlerts).toHaveLength(1);
    });
  });
});
