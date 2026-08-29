import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgotPasswordForm } from "./ForgotPasswordForm";
import { mockResponse } from "../lib/test-mock-response";

describe("ForgotPasswordForm", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shows the enumeration-safe success state after a valid submission", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({ data: { message: "If an account exists for that email, a reset link has been sent." } }),
    );
    render(<ForgotPasswordForm />);

    await userEvent.type(screen.getByLabelText("Email"), "owner@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(screen.getByText("owner@example.com", { exact: false })).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/forgot-password",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "owner@example.com" }) }),
    );
  });

  it("shows the SAME success state regardless of whether the account exists — never a different response for either case", async () => {
    // The backend itself returns an identical 200 either way; this only
    // proves the frontend doesn't introduce its own enumeration signal
    // (e.g. branching on response content) on top of that.
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({ data: { message: "If an account exists for that email, a reset link has been sent." } }),
    );
    render(<ForgotPasswordForm />);

    await userEvent.type(screen.getByLabelText("Email"), "nonexistent@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText("Check your email")).toBeInTheDocument();
  });

  it("shows a friendly error and stays on the form for a genuine system failure — never a silent false success", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "RATE_LIMITED", message: "Too many requests. Please try again later." }, 429));
    render(<ForgotPasswordForm />);

    await userEvent.type(screen.getByLabelText("Email"), "owner@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests");
    expect(screen.queryByText("Check your email")).not.toBeInTheDocument();
  });

  it("links back to /login", () => {
    render(<ForgotPasswordForm />);
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/login");
  });

  it("disables the submit button while the request is pending", async () => {
    let resolveFetch!: (value: Response) => void;
    jest.spyOn(global, "fetch").mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)) as Promise<Response>);
    render(<ForgotPasswordForm />);

    await userEvent.type(screen.getByLabelText("Email"), "owner@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByRole("button", { name: "Sending…" })).toBeDisabled();
    resolveFetch(mockResponse({ data: { message: "ok" } }));
    await waitFor(() => expect(screen.getByText("Check your email")).toBeInTheDocument());
  });
});
