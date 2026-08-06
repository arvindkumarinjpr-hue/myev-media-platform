import configuration, { WorkerConfigError } from "./configuration";

const REQUIRED_ENV = {
  DATABASE_URL: "postgresql://myev:pw@postgres:5432/myev_media",
  REDIS_URL: "redis://redis:6379",
  WORKER_QUEUES: "SYSTEM",
};

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const original = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    process.env = original;
  }
}

describe("configuration", () => {
  it("throws WorkerConfigError when DATABASE_URL is missing", () => {
    withEnv({ ...REQUIRED_ENV, DATABASE_URL: undefined }, () => {
      expect(() => configuration()).toThrow(/DATABASE_URL/);
    });
  });

  it("throws WorkerConfigError when REDIS_URL is missing", () => {
    withEnv({ ...REQUIRED_ENV, REDIS_URL: undefined }, () => {
      expect(() => configuration()).toThrow(/REDIS_URL/);
    });
  });

  it("throws WorkerConfigError when WORKER_QUEUES is missing", () => {
    withEnv({ ...REQUIRED_ENV, WORKER_QUEUES: undefined }, () => {
      expect(() => configuration()).toThrow(/WORKER_QUEUES is not set/);
    });
  });

  it("throws WorkerConfigError when WORKER_QUEUES contains an unrecognized queue name", () => {
    withEnv({ ...REQUIRED_ENV, WORKER_QUEUES: "SYSTEM,NOT_A_QUEUE" }, () => {
      expect(() => configuration()).toThrow(/unrecognized queue name/);
    });
  });

  it("parses a comma-separated WORKER_QUEUES into a trimmed array", () => {
    withEnv({ ...REQUIRED_ENV, WORKER_QUEUES: " SYSTEM , MAINTENANCE " }, () => {
      expect(configuration().queues).toEqual(["SYSTEM", "MAINTENANCE"]);
    });
  });

  it("applies documented defaults for optional values", () => {
    // Jest itself sets process.env.NODE_ENV="test" when otherwise unset —
    // explicitly clear it here so this assertion exercises the real
    // "nothing set" default path rather than Jest's own ambient value.
    withEnv({ ...REQUIRED_ENV, NODE_ENV: undefined }, () => {
      const config = configuration();
      expect(config.env).toBe("development");
      expect(config.logLevel).toBe("info");
      expect(config.applicationVersion).toBe("0.1.0");
      expect(config.heartbeatIntervalMs).toBe(15_000);
    });
  });

  it("respects explicit overrides", () => {
    withEnv(
      {
        ...REQUIRED_ENV,
        NODE_ENV: "production",
        LOG_LEVEL: "debug",
        WORKER_APPLICATION_VERSION: "1.2.3",
        WORKER_HEARTBEAT_INTERVAL_MS: "5000",
      },
      () => {
        const config = configuration();
        expect(config.env).toBe("production");
        expect(config.logLevel).toBe("debug");
        expect(config.applicationVersion).toBe("1.2.3");
        expect(config.heartbeatIntervalMs).toBe(5000);
      },
    );
  });

  it("WorkerConfigError carries the expected name", () => {
    withEnv({ ...REQUIRED_ENV, DATABASE_URL: undefined }, () => {
      expect.assertions(2);
      try {
        configuration();
      } catch (error) {
        expect(error).toBeInstanceOf(WorkerConfigError);
        expect((error as WorkerConfigError).name).toBe("WorkerConfigError");
      }
    });
  });
});
