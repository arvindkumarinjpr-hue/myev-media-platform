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
});
