import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PasswordResetForm } from "./PasswordResetForm";
import { mockResponse } from "../lib/test-mock-response";

let searchParams = new URLSearchParams("token=valid-token-placeholder");
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

async function fillAndSubmit(password: string, confirm: string, buttonName: string) {
  await userEvent.type(screen.getByLabelText("New password"), password);
  await userEvent.type(screen.getByLabelText("Confirm password"), confirm);
  await userEvent.click(screen.getByRole("button", { name: buttonName }));
}

describe("PasswordResetForm", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    searchParams = new URLSearchParams("token=valid-token-placeholder");
  });

  describe("mode=reset", () => {
    it("renders with a token present", () => {
      render(<PasswordResetForm mode="reset" />);
      expect(screen.getByRole("heading", { name: "Reset your password" })).toBeInTheDocument();
    });

    it("shows the invalid-link state immediately, without calling the API, when no token is present", () => {
      searchParams = new URLSearchParams("");
      const fetchSpy = jest.spyOn(global, "fetch");
      fetchSpy.mockClear();
      render(<PasswordResetForm mode="reset" />);

      expect(screen.getByText("Link invalid or expired")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Request a new link" })).toHaveAttribute("href", "/forgot-password");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("flags a password mismatch client-side and blocks submission", async () => {
      render(<PasswordResetForm mode="reset" />);
      await userEvent.type(screen.getByLabelText("New password"), "aaaaaaaaaaaa");
      await userEvent.type(screen.getByLabelText("Confirm password"), "bbbbbbbbbbbb");

      expect(await screen.findByText("Passwords don't match.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Reset password" })).toBeDisabled();
    });

    it("flags a too-short password client-side and blocks submission", async () => {
      render(<PasswordResetForm mode="reset" />);
      await userEvent.type(screen.getByLabelText("New password"), "short1234");

      expect(await screen.findByText("Must be at least 12 characters.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Reset password" })).toBeDisabled();
    });

    it("submits the token and new password, then shows success without auto-login", async () => {
      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: { success: true } }));
      render(<PasswordResetForm mode="reset" />);

      await fillAndSubmit("a-perfectly-fine-password", "a-perfectly-fine-password", "Reset password");

      expect(await screen.findByText("Password updated")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/auth/reset-password",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ token: "valid-token-placeholder", newPassword: "a-perfectly-fine-password" }),
        }),
      );
    });

    it("shows the invalid/expired state, with the backend's own message, when the token is rejected as invalid", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "AUTH_RESET_TOKEN_INVALID", message: "Link has already been used." }, 410));
      render(<PasswordResetForm mode="reset" />);

      await fillAndSubmit("a-perfectly-fine-password", "a-perfectly-fine-password", "Reset password");

      expect(await screen.findByText("Link invalid or expired")).toBeInTheDocument();
      expect(screen.getByText("Link has already been used.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Request a new link" })).toBeInTheDocument();
    });

    it("shows the invalid/expired state when the token has expired", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "AUTH_RESET_TOKEN_EXPIRED", message: "Link has expired." }, 410));
      render(<PasswordResetForm mode="reset" />);

      await fillAndSubmit("a-perfectly-fine-password", "a-perfectly-fine-password", "Reset password");

      expect(await screen.findByText("Link has expired.")).toBeInTheDocument();
    });

    it("shows an inline error (not a full-page state swap) for a password-reuse rejection, so the user can retry without a new link", async () => {
      jest
        .spyOn(global, "fetch")
        .mockResolvedValue(mockResponse({ code: "PASSWORD_REUSE_DETECTED", message: "You've used this password recently. Choose a different one." }, 400));
      render(<PasswordResetForm mode="reset" />);

      await fillAndSubmit("a-previously-used-password", "a-previously-used-password", "Reset password");

      expect(await screen.findByRole("alert")).toHaveTextContent("used this password recently");
      // Still on the form, not the terminal invalid-link state.
      expect(screen.getByRole("heading", { name: "Reset your password" })).toBeInTheDocument();
    });

    it("shows an inline error for an unexpected/network failure", async () => {
      jest.spyOn(global, "fetch").mockRejectedValue(new TypeError("network error"));
      render(<PasswordResetForm mode="reset" />);

      await fillAndSubmit("a-perfectly-fine-password", "a-perfectly-fine-password", "Reset password");

      expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    });

    it("never logs the token or the password to the console", async () => {
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: { success: true } }));
      render(<PasswordResetForm mode="reset" />);

      await fillAndSubmit("a-perfectly-fine-password", "a-perfectly-fine-password", "Reset password");
      await screen.findByText("Password updated");

      const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(" ");
      expect(allLoggedText).not.toContain("valid-token-placeholder");
      expect(allLoggedText).not.toContain("a-perfectly-fine-password");
    });
  });

  describe("mode=activate", () => {
    it("renders activation-specific copy", () => {
      render(<PasswordResetForm mode="activate" />);
      expect(screen.getByRole("heading", { name: "Activate your account" })).toBeInTheDocument();
    });

    it("shows the invalid-link state without an API call when no token is present, and does NOT offer /forgot-password (PENDING_ACTIVATION accounts aren't ACTIVE, so that flow would silently no-op for them)", () => {
      searchParams = new URLSearchParams("");
      // Cleared immediately after creation: this asserts nothing calls
      // fetch as a RESULT of this render — not that the historical call
      // count across the whole file happens to be zero, which is not
      // this test's concern.
      const fetchSpy = jest.spyOn(global, "fetch");
      fetchSpy.mockClear();
      render(<PasswordResetForm mode="activate" />);

      expect(screen.getByText("Link invalid or expired")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Request a new link" })).not.toBeInTheDocument();
      expect(screen.getByText("Please contact your workspace administrator for a new invitation link.")).toBeInTheDocument();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("submits and shows activation success, without auto-login", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: { success: true } }));
      render(<PasswordResetForm mode="activate" />);

      await fillAndSubmit("a-perfectly-fine-password", "a-perfectly-fine-password", "Activate account");

      expect(await screen.findByText("Account activated")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");
    });

    it("shows the invalid/expired state for a rejected activation token, with no /forgot-password CTA", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "AUTH_RESET_TOKEN_EXPIRED", message: "Link has expired." }, 410));
      render(<PasswordResetForm mode="activate" />);

      await fillAndSubmit("a-perfectly-fine-password", "a-perfectly-fine-password", "Activate account");

      expect(await screen.findByText("Link has expired.")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Request a new link" })).not.toBeInTheDocument();
    });
  });
});
