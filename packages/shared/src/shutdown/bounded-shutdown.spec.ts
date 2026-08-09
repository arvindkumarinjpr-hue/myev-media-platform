import { boundedShutdown } from "./bounded-shutdown";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("boundedShutdown", () => {
  it("returns GRACEFUL when gracefulClose resolves before the deadline", async () => {
    const forceClose = jest.fn();
    const outcome = await boundedShutdown(async () => delay(10), forceClose, 200);
    expect(outcome).toBe("GRACEFUL");
    expect(forceClose).not.toHaveBeenCalled();
  });

  it("returns FORCED and invokes forceClose when the deadline is reached before gracefulClose settles", async () => {
    const forceClose = jest.fn();
    // Never settles within the test's lifetime — simulates a genuinely
    // unreachable Redis, where the graceful close call structurally
    // cannot resolve or reject on its own.
    const neverSettles = () => new Promise<void>(() => undefined);
    const outcome = await boundedShutdown(neverSettles, forceClose, 20);
    expect(outcome).toBe("FORCED");
    expect(forceClose).toHaveBeenCalledTimes(1);
  });

  it("returns FORCED when gracefulClose rejects before the deadline — not GRACEFUL, not silently ignored", async () => {
    const forceClose = jest.fn();
    const outcome = await boundedShutdown(async () => Promise.reject(new Error("close failed")), forceClose, 200);
    expect(outcome).toBe("FORCED");
    expect(forceClose).toHaveBeenCalledTimes(1);
  });

  it("returns FAILED when forceClose itself throws, after a timeout", async () => {
    const outcome = await boundedShutdown(
      () => new Promise<void>(() => undefined),
      () => {
        throw new Error("force close also failed");
      },
      20,
    );
    expect(outcome).toBe("FAILED");
  });

  it("returns FAILED when forceClose throws after a gracefulClose rejection", async () => {
    const outcome = await boundedShutdown(
      async () => Promise.reject(new Error("close failed")),
      () => {
        throw new Error("force close also failed");
      },
      200,
    );
    expect(outcome).toBe("FAILED");
  });

  it("respects the deadline precisely — resolves at approximately deadlineMs, not open-ended", async () => {
    const start = Date.now();
    await boundedShutdown(() => new Promise<void>(() => undefined), () => undefined, 50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    // Generous upper bound — this only needs to prove "bounded," not pin
    // an exact millisecond ceiling under variable CI/test-runner load.
    expect(elapsed).toBeLessThan(500);
  });

  it("a gracefulClose that eventually rejects AFTER the deadline has already fired produces no unhandled rejection", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const lateRejector = async (): Promise<void> => {
        await delay(60);
        throw new Error("late failure, long after the deadline and after boundedShutdown has already returned");
      };
      const outcome = await boundedShutdown(lateRejector, () => undefined, 10);
      expect(outcome).toBe("FORCED");

      // Give the late rejection time to actually fire and be observed by
      // Node's unhandledRejection machinery, well after boundedShutdown
      // itself has already returned its result above.
      await delay(100);
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("forceClose is never invoked when gracefulClose resolves comfortably within the deadline, across repeated calls", async () => {
    const forceClose = jest.fn();
    for (let i = 0; i < 5; i++) {
      const outcome = await boundedShutdown(async () => delay(5), forceClose, 200);
      expect(outcome).toBe("GRACEFUL");
    }
    expect(forceClose).not.toHaveBeenCalled();
  });
});
