import { defineConfig } from "@playwright/test";

// Module 2 Phase 2.7 — one real browser-level integration test proving the
// Knowledge Pack workflow end-to-end. Deliberately the smallest useful
// setup: a single project (Chromium only, no cross-browser matrix), no
// webServer auto-start (the real backend + web dev server this exercises
// need real Postgres/Redis/MinIO/Mailpit already running — see the test
// file's own header for the exact local setup this expects). Not wired
// into the shared CI workflow; see the PR description for why.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3400",
    trace: "retain-on-failure",
  },
});
