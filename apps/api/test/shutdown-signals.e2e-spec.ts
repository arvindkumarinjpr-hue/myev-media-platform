import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import path from "path";
import http from "http";

/**
 * DEFECT-1F-001 — real OS signals to a real, separately-spawned API
 * process. This is the direct proof of the gap this defect's plan
 * specifically called out: apps/api previously never called
 * app.enableShutdownHooks() at all, so a real SIGTERM/SIGINT never
 * triggered OnModuleDestroy in production — only Test.createTestingModule
 * + explicit .close() (used everywhere else in this test suite) ever
 * exercised that path. This suite is the one place that could not have
 * caught the missing-hooks gap before, and is the one place that now
 * proves it is fixed.
 *
 * Deliberately healthy-Redis only (see this file's own note below) —
 * BackgroundJobsService.redisConnection is constructed lazily and this
 * process never issues an HTTP request that would trigger it (doing so
 * against a genuinely broken Redis risks the HTTP client itself hanging
 * on the same maxRetriesPerRequest:null behavior, a test-reliability
 * concern already avoided for this exact reason in this app's own
 * "Redis connection resilience" e2e suite). The FORCED-path bounded-
 * shutdown behavior for a real, constructed redisConnection is already
 * proven against real infrastructure by redis-shutdown.e2e-spec.ts;
 * this suite's job is specifically "do shutdown hooks fire on a real
 * signal at all," which is orthogonal to which Redis outcome follows.
 */
describe("API (e2e) — DEFECT-1F-001 real SIGTERM/SIGINT", () => {
  const API_ROOT = path.resolve(__dirname, "..");

  function spawnApi(port: number, extraEnv: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
    // Deliberately `node -r ts-node/register/transpile-only`, NOT
    // `pnpm exec ts-node` — see apps/worker's identical helper for the
    // full rationale (the wrapper-vs-real-process PID issue this
    // rewrite fixes).
    return spawn("node", ["-r", "ts-node/register/transpile-only", "src/main.ts"], {
      cwd: API_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        REDIS_SHUTDOWN_DEADLINE_MS: "2000",
        LOG_LEVEL: "error",
        ...extraEnv,
      },
    });
  }

  function collectStderr(child: ChildProcessWithoutNullStreams): { text: () => string } {
    let buffer = "";
    child.stderr.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
    });
    return { text: () => buffer };
  }

  interface ExitResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  }

  function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<ExitResult> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ code: null, signal: null, timedOut: true });
      }, timeoutMs);
      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal, timedOut: false });
      });
    });
  }

  function waitForHealthy(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = (): void => {
        const req = http.get({ host: "localhost", port, path: "/health", timeout: 1_000 }, (res) => {
          res.resume();
          if (res.statusCode === 200) {
            resolve();
          } else if (Date.now() < deadline) {
            setTimeout(attempt, 250);
          } else {
            reject(new Error(`API did not become healthy within ${timeoutMs}ms (last status ${res.statusCode})`));
          }
        });
        req.on("error", () => {
          if (Date.now() < deadline) setTimeout(attempt, 250);
          else reject(new Error(`API did not become healthy within ${timeoutMs}ms`));
        });
      };
      attempt();
    });
  }

  const spawnedProcesses: ChildProcessWithoutNullStreams[] = [];
  afterEach(() => {
    // Defensive-only backstop — a correctly-passing test never reaches
    // this with anything still alive (see waitForExit's own comment in
    // the worker-side twin of this suite).
    for (const child of spawnedProcesses.splice(0)) {
      if (!child.killed) child.kill("SIGKILL");
    }
  });

  it.each(["SIGTERM", "SIGINT"] as const)("%s: shutdown hooks now fire, bounded exit via correct signal termination, no external kill needed", async (signal) => {
    const port = 4100 + Math.floor(Math.random() * 400);
    const child = spawnApi(port);
    spawnedProcesses.push(child);

    await waitForHealthy(port, 15_000);

    child.kill(signal);
    const result = await waitForExit(child, 15_000);

    expect(result.timedOut).toBe(false);
    // Terminated BY the signal itself (code: null, signal: <name>) —
    // see apps/worker's identical test for the full rationale: this is
    // the correct, expected outcome once shutdown hooks actually run
    // (which, before this defect's fix, they never did at all for this
    // process — there was no signal handling here whatsoever).
    expect(result.signal).toBe(signal);
    expect(result.code).toBeNull();
  }, 30_000);

  describe("DEFECT-1F-001 FINAL SIGNAL ERROR-HANDLING FIX", () => {
    it.each(["SIGTERM", "SIGINT"] as const)(
      "%s while a lifecycle provider throws during app.close(): exits deterministically with code 1, no unhandled-rejection/uncaught-exception path, original signal NOT re-delivered",
      async (signal) => {
        const port = 4100 + Math.floor(Math.random() * 400);
        const child = spawnApi(port, { SIMULATE_SHUTDOWN_FAILURE: "true" });
        spawnedProcesses.push(child);
        const stderr = collectStderr(child);

        await waitForHealthy(port, 15_000);

        child.kill(signal);
        const result = await waitForExit(child, 15_000);

        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(1);
        expect(result.signal).toBeNull();

        const output = stderr.text();
        expect((output.match(/APPLICATION_SHUTDOWN_FAILED/g) ?? []).length).toBe(1);
        expect(output).toContain('"service":"myev-api"');
        expect(output).toContain(`"signal":"${signal}"`);
        expect(output).not.toMatch(/UnhandledPromiseRejectionWarning/i);
        expect(output).not.toMatch(/Unhandled promise rejection/i);
        expect(output).not.toMatch(/uncaught exception/i);
      },
      30_000,
    );

    it("ShutdownOutcomeTracker already contains FAILED while app.close() itself resolves cleanly: still exits 1", async () => {
      const port = 4100 + Math.floor(Math.random() * 400);
      const child = spawnApi(port, { SIMULATE_TRACKER_FAILURE: "true" });
      spawnedProcesses.push(child);

      await waitForHealthy(port, 15_000);

      child.kill("SIGTERM");
      const result = await waitForExit(child, 15_000);

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
    }, 30_000);

    it("near-simultaneous SIGTERM + SIGINT: the shutdown body executes exactly once, not twice", async () => {
      const port = 4100 + Math.floor(Math.random() * 400);
      const child = spawnApi(port, { SIMULATE_SHUTDOWN_FAILURE: "true" });
      spawnedProcesses.push(child);
      const stderr = collectStderr(child);

      await waitForHealthy(port, 15_000);

      child.kill("SIGTERM");
      child.kill("SIGINT");
      const result = await waitForExit(child, 15_000);

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);

      const occurrences = (stderr.text().match(/APPLICATION_SHUTDOWN_FAILED/g) ?? []).length;
      expect(occurrences).toBe(1);
    }, 30_000);
  });
});
