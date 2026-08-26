import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * Module 4 Phase 4.1 — the golden-path browser proof for the first real
 * business-agent feature, mirroring knowledge-pack-workflow.spec.ts's
 * own established pattern exactly (backend-direct setup for what isn't
 * under test, UI-driven for what is). Local setup this expects is
 * identical to that file's own: real Postgres/Redis/MinIO/Mailpit, the
 * API on BACKEND_URL (default http://localhost:4300) with a real Worker
 * process also running against the same Redis/Postgres, and `pnpm dev`
 * for this app on PLAYWRIGHT_BASE_URL (default http://localhost:3400).
 *
 * No OPENAI_API_KEY/etc. is assumed to be set for this local proof —
 * the research job is therefore expected to reach a real terminal
 * FAILED/PROVIDER_NOT_CONFIGURED state (Module 3 Phase 3.5's own
 * resolver behavior, unchanged), which is itself the thing this test
 * proves the UI renders safely (never a raw provider payload, never a
 * crash) — exactly as real as the happy path from this UI's own
 * perspective, since it never has any AI-specific knowledge either way.
 */

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:4300";
const OWNER_EMAIL = process.env.BOOTSTRAP_OWNER_EMAIL ?? "owner@myevmedia.com";
const OWNER_PASSWORD = process.env.BOOTSTRAP_OWNER_PASSWORD ?? "ci-only-owner-password-do-not-use-elsewhere-123";
const ALL_CONTENT_TYPES = ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"];

async function createWorkspaceWithActivePack(request: APIRequestContext): Promise<{ workspaceId: string; accessToken: string }> {
  const loginRes = await request.post(`${BACKEND_URL}/api/v1/auth/login`, { data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
  const { data } = await loginRes.json();
  const accessToken = data.access_token as string;

  const slug = `pw-research-${Date.now()}`;
  const wsRes = await request.post(`${BACKEND_URL}/api/v1/workspaces`, { headers: { Authorization: `Bearer ${accessToken}` }, data: { name: `Playwright Research ${slug}`, slug } });
  const ws = (await wsRes.json()).data;
  const workspaceId = ws.publicId as string;
  const authHeaders = { Authorization: `Bearer ${accessToken}`, "X-Workspace-Id": workspaceId };

  const kpRes = await request.post(`${BACKEND_URL}/api/v1/workspaces/${workspaceId}/knowledge-packs`, {
    headers: authHeaders,
    data: { name: "Research Playwright Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: { cadence: "weekly" } },
  });
  const kp = (await kpRes.json()).data;
  await request.patch(`${BACKEND_URL}/api/v1/workspaces/${workspaceId}/knowledge-packs/${kp.publicId}`, {
    headers: authHeaders,
    data: {
      expectedLockVersion: 1,
      sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }],
      promptTemplates: ALL_CONTENT_TYPES.map((contentType) => ({ contentType, promptBody: "Write something useful" })),
    },
  });
  await request.post(`${BACKEND_URL}/api/v1/workspaces/${workspaceId}/knowledge-packs/${kp.publicId}/validate`, { headers: authHeaders });

  return { workspaceId, accessToken };
}

test("sign in, submit research against an active Knowledge Pack, and watch it reach a terminal state safely", async ({ page, request }) => {
  const { workspaceId } = await createWorkspaceWithActivePack(request);

  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspaces$/);

  await page.goto(`/workspaces/${workspaceId}/research`);
  await expect(page.getByText("No research yet")).toBeVisible();

  await page.getByRole("link", { name: "New Research" }).click();
  await page.getByLabel("Topic").fill("EV battery swap stations");
  await page.getByLabel("Knowledge Pack").selectOption({ label: "Research Playwright Pack" });
  await page.getByRole("button", { name: "Start Research" }).click();

  // Navigated to the detail page — real durable dispatch, not a client-side
  // optimistic render (the URL itself proves the server round-trip).
  // Deliberately not asserting the transient Queued/Running text here — a
  // FakeProvider-less local stack resolves PROVIDER_NOT_CONFIGURED fast
  // enough that the real Worker can reach a terminal state before this
  // page even finishes its first paint; asserting a state that fast is
  // itself proof the pipeline works, not something to race against.
  await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}/research/[0-9a-f-]+$`));

  // Poll for a real terminal state — the app's own polling loop drives
  // this, this test only waits for whichever terminal status actually
  // lands (real Worker, real BullMQ, real provider-resolution outcome).
  // Branch on the status badge itself (a single, always-current element)
  // rather than a separately-read body-text snapshot, which can go stale
  // between the read and the branch on a fast-resolving local stack.
  const terminalFailure = page.getByText(/^(Failed|Timed out)$/);
  const terminalSuccess = page.getByText("Completed", { exact: true });
  await expect(terminalFailure.or(terminalSuccess)).toBeVisible({ timeout: 30_000 });

  if (await terminalFailure.isVisible()) {
    // No provider configured in this local dev stack — the expected,
    // real outcome. Prove the error rendering is safe: a curated
    // message, never a raw provider/stack-trace payload. Next.js's own
    // route announcer also carries role="alert" (empty, off-screen) —
    // scope to the one ErrorBanner actually renders with real text.
    const errorAlert = page.getByRole("alert").filter({ hasText: /.+/ });
    await expect(errorAlert).toBeVisible();
    const alertText = await errorAlert.innerText();
    expect(alertText.toLowerCase()).not.toContain("at object.");
    expect(alertText.toLowerCase()).not.toContain("stack");
  } else {
    await expect(page.getByText("Summary")).toBeVisible();
  }
});
