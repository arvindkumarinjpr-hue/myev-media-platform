import { render } from "@testing-library/react";

/**
 * Cross-layer regression protection (Module 6 Phase 6.5-D UAT finding):
 * the backend's forgot-password and account-activation emails link to
 * `${APP_URL}/reset-password?token=...` and `${APP_URL}/activate?token=...`
 * (apps/api/src/modules/auth/auth.service.ts, invitation-activation.service.ts)
 * — but for the entire history of this repository, no frontend page ever
 * existed at either path, so those links silently resolved to Next.js's
 * own generic 404 instead. A component-level test of PasswordResetForm
 * alone would NOT have caught this: the defect was that the App Router
 * *page file* itself was missing, not that the form was broken.
 *
 * This test imports the actual route files Next.js resolves those URLs
 * to (not a mock, not a re-implementation) and renders their real
 * default export — if either page file is ever deleted, renamed, or
 * stops exporting a valid page component, this fails immediately instead
 * of silently shipping another email -> 404 regression.
 */

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("token=test-token-placeholder"),
}));

describe("auth recovery/activation route files exist and render", () => {
  it("apps/web/app/reset-password/page.tsx renders", async () => {
    const { default: ResetPasswordPage } = await import("../app/reset-password/page");
    expect(() => render(<ResetPasswordPage />)).not.toThrow();
  });

  it("apps/web/app/activate/page.tsx renders", async () => {
    const { default: ActivatePage } = await import("../app/activate/page");
    expect(() => render(<ActivatePage />)).not.toThrow();
  });

  it("apps/web/app/forgot-password/page.tsx renders", async () => {
    const { default: ForgotPasswordPage } = await import("../app/forgot-password/page");
    expect(() => render(<ForgotPasswordPage />)).not.toThrow();
  });
});
