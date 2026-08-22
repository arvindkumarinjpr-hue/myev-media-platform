import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateKnowledgePackForm } from "./CreateKnowledgePackForm";
import { mockResponse } from "../../lib/test-mock-response";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

describe("CreateKnowledgePackForm", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    push.mockClear();
  });

  it("creates a Draft and navigates to its editor", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: { publicId: "kp-new", name: "New Pack" } }, 201));
    render(<CreateKnowledgePackForm workspaceId="ws-1" />);

    await userEvent.type(screen.getByLabelText("Name"), "New Pack");
    await userEvent.click(screen.getByRole("button", { name: "Create Draft" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/workspaces/ws-1/knowledge-packs/kp-new"));
  });

  it("shows a friendly error and does not navigate on failure", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "KNOWLEDGE_VALIDATION_FAILED", message: "name is required" }, 422));
    render(<CreateKnowledgePackForm workspaceId="ws-1" />);

    await userEvent.type(screen.getByLabelText("Name"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Create Draft" }));

    await waitFor(() => expect(screen.getByText("name is required")).toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
  });

  it("disables the submit button while the name field is empty", () => {
    render(<CreateKnowledgePackForm workspaceId="ws-1" />);
    expect(screen.getByRole("button", { name: "Create Draft" })).toBeDisabled();
  });
});
