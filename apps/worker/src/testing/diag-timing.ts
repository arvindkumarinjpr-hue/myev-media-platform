/* DIAG ONLY — temporary forensic instrumentation for the CI-only Worker
 * E2E slowdown investigation (Module 1F Phase A hardening). Not part of
 * any approved defect fix. Will be fully deleted, and every call site
 * that references it reverted, before any real PR is opened or merged.
 * Uses raw console.log (never pino) so LOG_LEVEL can never suppress it.
 */

export function diagLog(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ diag: true, event, time: Date.now(), pid: process.pid, ...fields }));
}

interface DiagConnectionLike {
  on(event: "error", listener: (error: unknown) => void): unknown;
}

/** Attaches an ADDITIONAL listener alongside whatever production listener already exists — never replaces it, never changes retry/reconnect behavior. */
export function diagWrapConnection(connection: DiagConnectionLike, label: string, target: string): void {
  const createdAt = Date.now();
  diagLog("DIAG_CONNECTION_CREATED", { label, target, createdAt });
  let attempt = 0;
  connection.on("error", (error) => {
    attempt += 1;
    const err = error as { code?: string; message?: string } | undefined;
    diagLog("DIAG_CONNECTION_ERROR", {
      label,
      target,
      attempt,
      code: err?.code ?? null,
      message: err?.message ?? null,
      elapsedSinceCreateMs: Date.now() - createdAt,
    });
  });
}
