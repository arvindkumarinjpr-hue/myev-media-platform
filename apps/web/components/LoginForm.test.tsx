import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginForm } from "./LoginForm";
import { mockResponse } from "../lib/test-mock-response";

const push = jest.fn();
const refresh = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
  useSearchParams: () => new URLSearchParams(""),
}));

describe("LoginForm", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    push.mockClear();
    refresh.mockClear();
  });

  it("signs in and redirects to the safe next path", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: { user: { publicId: "u1" } } }));
    render(<LoginForm />);

    await userEvent.type(screen.getByLabelText("Email"), "owner@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "hunter2hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/workspaces"));
    expect(refresh).toHaveBeenCalled();
  });

  it("shows a friendly error and stays on the form when the credentials are rejected", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(mockResponse({ code: "AUTH_INVALID_CREDENTIALS", message: "Invalid email or password." }, 401));
    render(<LoginForm />);

    await userEvent.type(screen.getByLabelText("Email"), "owner@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "wrongpassword");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password.");
    expect(push).not.toHaveBeenCalled();
  });

  it("toggles password visibility client-side without affecting the submitted value", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: { user: { publicId: "u1" } } }));
    render(<LoginForm />);

    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password).toHaveAttribute("type", "password");

    const toggle = screen.getByRole("button", { name: "Show password" });
    await userEvent.type(password, "hunter2hunter2");
    await userEvent.click(toggle);

    expect(password).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password).toHaveAttribute("type", "password");

    // Toggling visibility must never touch the actual value or submit the form.
    expect(password.value).toBe("hunter2hunter2");
    expect(push).not.toHaveBeenCalled();
  });
});
