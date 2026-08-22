import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * Module 2 Phase 2.7 — one real browser-level integration test exercising
 * the Knowledge Pack workflow against the real backend, per the explicit
 * instruction not to mock the business workflow for the final integration
 * proof. Session-expiry/401-redirect is deliberately NOT re-tested here —
 * lib/api-client.test-adjacent unit coverage already proves that specific
 * mechanism directly; duplicating it as a slow real-browser wait-for-JWT-
 * expiry test would add real CI time for no additional confidence.
 *
 * Local setup this expects (see the PR description for the exact
 * commands): real Postgres/Redis/MinIO/Mailpit, the API built+running on
 * BACKEND_URL (default http://localhost:4300), and `pnpm dev` for this
 * app on PLAYWRIGHT_BASE_URL (default http://localhost:3400).
 */

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:4300";
const OWNER_EMAIL = process.env.BOOTSTRAP_OWNER_EMAIL ?? "owner@myevmedia.com";
const OWNER_PASSWORD = process.env.BOOTSTRAP_OWNER_PASSWORD ?? "ci-only-owner-password-do-not-use-elsewhere-123";
const ALL_CONTENT_TYPES = ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"];

/** Backend-direct setup helper (not the thing under test) — creates a fresh workspace so each test run starts clean, mirroring how the curl-based flow proof was seeded. */
async function createWorkspace(request: APIRequestContext): Promise<{ workspaceId: string; accessToken: string }> {
  const loginRes = await request.post(`${BACKEND_URL}/api/v1/auth/login`, { data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
  const { data } = await loginRes.json();
  const accessToken = data.access_token as string;

  const slug = `pw-${Date.now()}`;
  const wsRes = await request.post(`${BACKEND_URL}/api/v1/workspaces`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { name: `Playwright ${slug}`, slug },
  });
  const ws = await wsRes.json();
  return { workspaceId: ws.data.publicId as string, accessToken };
}

test("unauthenticated visit to a workspace route redirects to /login", async ({ page }) => {
  await page.goto("/workspaces/00000000-0000-0000-0000-000000000000/knowledge-packs");
  await expect(page).toHaveURL(/\/login\?next=/);
});

test("sign in, create a Knowledge Pack, complete configuration, and activate it", async ({ page, request }) => {
  const { workspaceId } = await createWorkspace(request);

  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspaces$/);

  await page.goto(`/workspaces/${workspaceId}/knowledge-packs`);
  await expect(page.getByText("No Knowledge Packs yet")).toBeVisible();

  await page.getByRole("link", { name: "New Knowledge Pack" }).click();
  await page.getByLabel("Name").fill("Playwright EV Pack");
  await page.getByRole("button", { name: "Create Draft" }).click();
  await expect(page.getByRole("heading", { name: "Playwright EV Pack" })).toBeVisible();

  // Validate while incomplete — the itemized failure list must actually render.
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText(/At least one trusted knowledge source is required/)).toBeVisible();

  // Complete the required sections through the real form controls. Create
  // deliberately only sends `name` (see CreateKnowledgePackForm) — industry
  // profile and publishing strategy start as `{}` and must be filled in
  // here too, or the FR-KP-001/FR-KP-004 gates never pass.
  await page.getByLabel("Industry profile").fill('{"industry":"Electric Vehicles"}');
  await page.getByLabel("Publishing strategy").fill('{"cadence":"weekly"}');
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByPlaceholder("https://…").fill("https://example.gov");

  const templatesSection = page.locator("section", { has: page.getByRole("heading", { name: "Prompt templates" }) });
  for (const contentType of ALL_CONTENT_TYPES) {
    await page.getByRole("button", { name: "Add template" }).click();
  }
  // Every new row defaults to BLOG — each must be set to a distinct content
  // type for the "one template per type" gate to actually pass.
  const contentTypeSelects = templatesSection.locator("select");
  for (let i = 0; i < ALL_CONTENT_TYPES.length; i++) {
    await contentTypeSelects.nth(i).selectOption(ALL_CONTENT_TYPES[i]);
  }
  const promptBodies = templatesSection.getByPlaceholder("Write about {{topic}}…");
  const count = await promptBodies.count();
  for (let i = 0; i < count; i++) {
    await promptBodies.nth(i).fill("Write something useful");
  }
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled();

  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
});

test("RESTRICT is shown when a successor is blocked by a referencing Project, and clears after explicit reassignment", async ({ page, request }) => {
  const { workspaceId, accessToken } = await createWorkspace(request);

  // Seed an Active pack and a Project referencing it directly via the
  // backend — this test is about what the UI *shows* for the RESTRICT
  // path, not re-proving the create/configure/activate flow again.
  const kpRes = await request.post(`${BACKEND_URL}/api/v1/workspaces/${workspaceId}/knowledge-packs`, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Workspace-Id": workspaceId },
    data: { name: "Restrict Demo Pack", industryProfile: { industry: "EV" }, publishingStrategy: { cadence: "weekly" } },
  });
  const kp = (await kpRes.json()).data;
  await request.patch(`${BACKEND_URL}/api/v1/workspaces/${workspaceId}/knowledge-packs/${kp.publicId}`, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Workspace-Id": workspaceId },
    data: {
      expectedLockVersion: 1,
      sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }],
      promptTemplates: ALL_CONTENT_TYPES.map((contentType) => ({ contentType, promptBody: "x" })),
    },
  });
  await request.post(`${BACKEND_URL}/api/v1/workspaces/${workspaceId}/knowledge-packs/${kp.publicId}/validate`, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Workspace-Id": workspaceId },
  });
  const projectRes = await request.post(`${BACKEND_URL}/api/v1/workspaces/${workspaceId}/projects`, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Workspace-Id": workspaceId },
    data: { name: "Restrict Demo Project", slug: `restrict-${Date.now()}` },
  });
  const project = (await projectRes.json()).data;
  await request.patch(`${BACKEND_URL}/api/v1/workspaces/${workspaceId}/projects/${project.publicId}`, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Workspace-Id": workspaceId },
    data: { knowledgePackId: kp.publicId },
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Without this, the next page.goto() can race the login POST + cookie
  // set and land back on /login (as it did before this fix) — same
  // synchronization point test 2 already waits on.
  await expect(page).toHaveURL(/\/workspaces$/);

  await page.goto(`/workspaces/${workspaceId}/knowledge-packs/${kp.publicId}`);
  await page.getByRole("tab", { name: "Versions" }).click();
  await page.getByRole("button", { name: "Create new Draft version" }).click();
  await expect(page).toHaveURL(/knowledge-packs\/[0-9a-f-]+$/);

  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText(/RESTRICT/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage Project assignments" })).toBeVisible();

  // Resolve it through the real Project UI, then confirm the retry succeeds.
  await page.getByRole("link", { name: "Manage Project assignments" }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}/projects$`));
  await page.getByRole("link", { name: "Manage", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}/projects/[0-9a-f-]+$`));
  await page.getByLabel("Currently assigned").selectOption("__unassigned__");
  await page.getByRole("button", { name: "Save assignment" }).click();

  await page.goto(`/workspaces/${workspaceId}/knowledge-packs`);
  await page.getByRole("link", { name: "Open", exact: true }).last().click();
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
});
