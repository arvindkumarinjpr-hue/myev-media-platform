import configuration from "./configuration";

describe("configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("falls back to development defaults when NODE_ENV is unset", () => {
    delete process.env.NODE_ENV;
    delete process.env.PORT;
    const config = configuration();
    expect(config.env).toBe("development");
    expect(config.port).toBe(4000);
  });

  it("reads PORT and DATABASE_URL from the environment", () => {
    process.env.PORT = "5000";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    const config = configuration();
    expect(config.port).toBe(5000);
    expect(config.databaseUrl).toBe("postgresql://user:pass@localhost:5432/db");
  });

  it("treats STORAGE_USE_SSL as false unless explicitly 'true'", () => {
    process.env.STORAGE_USE_SSL = "false";
    expect(configuration().storage.useSsl).toBe(false);
    process.env.STORAGE_USE_SSL = "true";
    expect(configuration().storage.useSsl).toBe(true);
  });
});
