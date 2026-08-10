import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import path from "path";
import { PrismaService } from "../src/prisma/prisma.service";

/**
 * DEFECT-1F-001 — real OS signals to a real, separately-spawned worker
 * process (not Test.createTestingModule, which never exercises
 * enableShutdownHooks()'s actual signal-to-close() wiring at all). This
 * is the one test category that can prove the apps/api gap this defect
 * also fixes (enableShutdownHooks() was previously never called there)
 * actually matters: without it, a real SIGTERM never triggers
 * OnModuleDestroy in the first place.
 */
describe("Worker (e2e) — DEFECT-1F-001 real SIGTERM/SIGINT", () => {
  const WORKER_ROOT = path.resolve(__dirname, "..");
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function spawnWorker(applicationVersion: string, extraEnv: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
    // Deliberately `node -r ts-node/register/transpile-only`, NOT
    // `pnpm exec ts-node` — the latter's spawned ChildProcess is pnpm's
    // own wrapper, not the actual Node process running main.ts (the
    // exact "wrapper vs. child PID" issue already documented elsewhere
    // in this project's own CI investigation history). Signals sent to
    // the wrapper do not reliably reach — or reliably reflect the exit
    // semantics of — the real application process, which silently
    // invalidated this file's own exit-code assertions until caught by
    // the FINAL SIGNAL ERROR-HANDLING FIX's new exit(1)-specific tests
    // (a `code:null,signal:name` expectation happens to also be what a
    // signal-killed wrapper produces, which is why the earlier,
    // less-specific tests did not surface this). Spawning `node`
    // directly with no wrapper process means `child.pid` IS the real
    // process, so `child.kill()` and this file's exit-code/signal
    // assertions are actually about the code under test.
    return spawn("node", ["-r", "ts-node/register/transpile-only", "src/main.ts"], {
      cwd: WORKER_ROOT,
      env: {
        ...process.env,
        WORKER_QUEUES: "SYSTEM",
        WORKER_APPLICATION_VERSION: applicationVersion,
        WORKER_HEARTBEAT_INTERVAL_MS: "2000",
        REDIS_SHUTDOWN_DEADLINE_MS: "2000",
        SCHEDULER_REGISTRATION_TIMEOUT_MS: "2000",
        LOG_LEVEL: "error",
        ...extraEnv,
      },
    });
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
        // A test timing out here is a FAILING test, not a passing one
        // worked around by killing the child — see this suite's own
        // afterEach, which only exists as a defensive backstop against a
        // genuinely-failing test leaving a process behind, never as part
        // of the success path.
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

  async function waitForHeartbeat(applicationVersion: string, startedAfter: Date, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const count = await prisma.workerHeartbeat.count({ where: { applicationVersion, startedAt: { gte: startedAfter } } });
      if (count > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`worker "${applicationVersion}" did not report a heartbeat within ${timeoutMs}ms`);
  }

  function collectStderr(child: ChildProcessWithoutNullStreams): { text: () => string } {
    let buffer = "";
    child.stderr.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
    });
    return { text: () => buffer };
  }

  // TEMPORARY DIAGNOSTIC — shutdown-signals forensics, remove before merge.
  function collectStdout(child: ChildProcessWithoutNullStreams): { text: () => string } {
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
    });
    return { text: () => buffer };
  }

  // TEMPORARY DIAGNOSTIC — shutdown-signals forensics, remove before merge.
  // Prints unconditionally, BEFORE any assertion runs, so the full child
  // output is always visible in the Jest log regardless of pass/fail.
  function dumpDiagnostics(
    label: string,
    result: { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean },
    stdout: { text: () => string },
    stderr: { text: () => string },
  ): void {
    console.log(`DIAG_RESULT[${label}] code=${result.code} signal=${result.signal} timedOut=${result.timedOut}`);
    console.log(`DIAG_STDOUT_BEGIN[${label}]\n${stdout.text()}\nDIAG_STDOUT_END[${label}]`);
    console.log(`DIAG_STDERR_BEGIN[${label}]\n${stderr.text()}\nDIAG_STDERR_END[${label}]`);
  }

  const spawnedProcesses: ChildProcessWithoutNullStreams[] = [];
  afterEach(async () => {
    // Defensive-only backstop (see waitForExit's own comment) — a
    // correctly-passing test never reaches this with anything still
    // alive.
    for (const child of spawnedProcesses.splice(0)) {
      if (!child.killed) child.kill("SIGKILL");
    }
  });

  it.each(["SIGTERM", "SIGINT"] as const)("%s against a healthy Redis: bounded exit via correct signal termination, no external kill needed", async (signal) => {
    const applicationVersion = `e2e-signal-${signal.toLowerCase()}-${Date.now()}`;
    const startedAfter = new Date();
    const child = spawnWorker(applicationVersion);
    spawnedProcesses.push(child);

    await waitForHeartbeat(applicationVersion, startedAfter, 15_000);

    child.kill(signal);
    const result = await waitForExit(child, 15_000);

    expect(result.timedOut).toBe(false);
    // Terminated BY the signal itself (code: null, signal: <name>), not
    // code 0 — this is the correct, expected outcome: main.ts's own
    // signal handler awaits app.close() (running every shutdown hook to
    // completion, bounded) and only then re-delivers the original
    // signal for the OS's default disposition to actually terminate the
    // process — standard Unix daemon behavior, and proof the process
    // was never externally SIGKILLed to end the test.
    expect(result.signal).toBe(signal);
    expect(result.code).toBeNull();

    await prisma.workerHeartbeat.deleteMany({ where: { applicationVersion } });
  }, 30_000);

  it("SIGTERM against a genuinely unreachable Redis: still exits within the bounded deadline via correct signal termination (FORCED still terminates via the signal, not a distinct exit code — see main.ts's own policy comment)", async () => {
    // The worker must reach a live, heartbeating state on a HEALTHY
    // Redis/Postgres first (that's what proves bootstrap itself is
    // fine) — this test is about SHUTDOWN behavior once Redis then
    // becomes unreachable, not about bootstrap against a broken Redis
    // (already covered in redis-shutdown.e2e-spec.ts).
    //
    // Simulating "Redis becomes unreachable at shutdown time" for a
    // real spawned process without an actual network-level fault
    // injection tool is done the same way this project already does it
    // elsewhere in-process (REDIS_URL pointed at a real, resolvable
    // hostname whose port refuses) — here, achieved by launching with a
    // broken REDIS_URL from the start, which still proves the exact
    // property under test (bounded, correctly-coded shutdown even when
    // every Redis operation the shutdown path attempts fails) without
    // requiring bootstrap to have first succeeded against a healthy one.
    const applicationVersion = `e2e-signal-broken-${Date.now()}`;
    const child = spawnWorker(applicationVersion, { REDIS_URL: "redis://redis:1" });
    spawnedProcesses.push(child);

    // No heartbeat wait here — WorkerHeartbeatService writes to
    // Postgres, not Redis, so it succeeds regardless; a short fixed
    // delay is enough to let bootstrap (bounded by DEFECT-1F-004's own
    // registration timeout) reach a steady, fully-running state before
    // signaling.
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    child.kill("SIGTERM");
    const result = await waitForExit(child, 15_000);

    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe("SIGTERM");
    expect(result.code).toBeNull();

    await prisma.workerHeartbeat.deleteMany({ where: { applicationVersion } });
  }, 30_000);

  describe("DEFECT-1F-001 FINAL SIGNAL ERROR-HANDLING FIX", () => {
    it.each(["SIGTERM", "SIGINT"] as const)(
      "%s while a lifecycle provider throws during app.close(): exits deterministically with code 1, no unhandled-rejection/uncaught-exception path, original signal NOT re-delivered",
      async (signal) => {
        const applicationVersion = `e2e-signal-failure-${signal.toLowerCase()}-${Date.now()}`;
        const startedAfter = new Date();
        const child = spawnWorker(applicationVersion, { SIMULATE_SHUTDOWN_FAILURE: "true" });
        spawnedProcesses.push(child);
        const stderr = collectStderr(child);
        const stdout = collectStdout(child); // TEMPORARY DIAGNOSTIC

        await waitForHeartbeat(applicationVersion, startedAfter, 15_000);

        child.kill(signal);
        const result = await waitForExit(child, 15_000);
        dumpDiagnostics(`signal-failure-${signal}`, result, stdout, stderr); // TEMPORARY DIAGNOSTIC — before any assertion

        expect(result.timedOut).toBe(false);
        // Deterministic exit(1) — NOT terminated by the signal itself
        // (that would mean the catch block's process.exit(1) never ran,
        // and the code fell through to the normal re-kill path anyway).
        expect(result.code).toBe(1);
        expect(result.signal).toBeNull();

        const output = stderr.text();
        // The controlled path: exactly one structured failure log.
        expect((output.match(/APPLICATION_SHUTDOWN_FAILED/g) ?? []).length).toBe(1);
        expect(output).toContain('"service":"myev-worker"');
        expect(output).toContain(`"signal":"${signal}"`);
        // Never the raw error's stack/message routed through Node's own
        // default unhandled-rejection/uncaught-exception banners — those
        // have very distinctive, unmistakable text this controlled path
        // never produces.
        expect(output).not.toMatch(/UnhandledPromiseRejectionWarning/i);
        expect(output).not.toMatch(/Unhandled promise rejection/i);
        expect(output).not.toMatch(/uncaught exception/i);

        await prisma.workerHeartbeat.deleteMany({ where: { applicationVersion } });
      },
      30_000,
    );

    it("ShutdownOutcomeTracker already contains FAILED while app.close() itself resolves cleanly: still exits 1", async () => {
      const applicationVersion = `e2e-signal-tracker-failure-${Date.now()}`;
      const startedAfter = new Date();
      const child = spawnWorker(applicationVersion, { SIMULATE_TRACKER_FAILURE: "true" });
      spawnedProcesses.push(child);
      const stderrTf = collectStderr(child); // TEMPORARY DIAGNOSTIC
      const stdoutTf = collectStdout(child); // TEMPORARY DIAGNOSTIC

      await waitForHeartbeat(applicationVersion, startedAfter, 15_000);

      child.kill("SIGTERM");
      const result = await waitForExit(child, 15_000);
      dumpDiagnostics("tracker-failure", result, stdoutTf, stderrTf); // TEMPORARY DIAGNOSTIC — before any assertion

      expect(result.timedOut).toBe(false);
      // This exercises the OTHER branch — app.close() resolves (no
      // exception, no APPLICATION_SHUTDOWN_FAILED log expected), but
      // shutdownTracker.hasFailure() is still true, so exit(1) still
      // fires, proving that pre-existing branch is unaffected by this
      // fix's new try/catch.
      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();

      await prisma.workerHeartbeat.deleteMany({ where: { applicationVersion } });
    }, 30_000);

    it("near-simultaneous SIGTERM + SIGINT: the shutdown body executes exactly once, not twice", async () => {
      const applicationVersion = `e2e-signal-race-${Date.now()}`;
      const startedAfter = new Date();
      const child = spawnWorker(applicationVersion, { SIMULATE_SHUTDOWN_FAILURE: "true" });
      spawnedProcesses.push(child);
      const stderr = collectStderr(child);
      const stdoutRace = collectStdout(child); // TEMPORARY DIAGNOSTIC

      await waitForHeartbeat(applicationVersion, startedAfter, 15_000);

      // Fired back-to-back, deliberately not awaiting anything between
      // them — the shuttingDown guard must make the second one a no-op.
      child.kill("SIGTERM");
      child.kill("SIGINT");
      const result = await waitForExit(child, 15_000);
      dumpDiagnostics("near-simultaneous", result, stdoutRace, stderr); // TEMPORARY DIAGNOSTIC — before any assertion

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);

      // The direct, observable proof of "executed once": if the guard
      // failed and the shutdown body ran twice, this log line — which
      // only main.ts's own catch block ever emits, once per invocation
      // — would appear twice.
      const occurrences = (stderr.text().match(/APPLICATION_SHUTDOWN_FAILED/g) ?? []).length;
      expect(occurrences).toBe(1);

      await prisma.workerHeartbeat.deleteMany({ where: { applicationVersion } });
    }, 30_000);
  });
});
