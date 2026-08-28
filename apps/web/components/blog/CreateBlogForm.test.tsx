import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateBlogForm } from "./CreateBlogForm";
import { mockResponse } from "../../lib/test-mock-response";
import { pipeline } from "./blogTestFixtures";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const ACTIVE_PACK = { publicId: "kp-1", name: "EV Pack", status: "ACTIVE", versionNumber: 2 };

describe("CreateBlogForm", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    push.mockClear();
  });

  it("creates an article (deterministic QUEUED brief) and navigates to its pipeline page", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(mockResponse({ data: [ACTIVE_PACK] }))
      .mockResolvedValueOnce(
        mockResponse({ data: pipeline({ contentItem: { publicId: "blog-new", title: "Home charging", contentType: "BLOG", status: "IN_PROGRESS" }, brief: { status: "GENERATING", aiJobPublicId: "job-1", artifact: null, approvedAt: null, failureReason: null } }) }, 202),
      );

    render(<CreateBlogForm workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByLabelText("Topic")).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText("Topic"), "Home charging costs");
    await userEvent.selectOptions(screen.getByLabelText("Knowledge Pack"), "kp-1");
    await userEvent.click(screen.getByRole("button", { name: "Create Blog" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/workspaces/ws-1/blog/blog-new"));
  });

  it("warns instead of showing the form when there is no ACTIVE Knowledge Pack", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [{ publicId: "kp-1", name: "Draft", status: "DRAFT", versionNumber: 1 }] }));
    render(<CreateBlogForm workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByText("No active Knowledge Pack")).toBeInTheDocument());
    expect(screen.queryByLabelText("Topic")).not.toBeInTheDocument();
  });

  it("surfaces a backend business error without navigating", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(mockResponse({ data: [ACTIVE_PACK] }))
      .mockResolvedValueOnce(mockResponse({ code: "BLOG_KNOWLEDGE_PACK_NOT_ACTIVE", message: "Knowledge Pack is not ACTIVE." }, 422));

    render(<CreateBlogForm workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByLabelText("Topic")).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText("Topic"), "x");
    await userEvent.selectOptions(screen.getByLabelText("Knowledge Pack"), "kp-1");
    await userEvent.click(screen.getByRole("button", { name: "Create Blog" }));

    await waitFor(() => expect(screen.getByText("Knowledge Pack is not ACTIVE.")).toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps submit disabled until both topic and pack are chosen", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [ACTIVE_PACK] }));
    render(<CreateBlogForm workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Create Blog" })).toBeDisabled());
    await userEvent.type(screen.getByLabelText("Topic"), "topic");
    expect(screen.getByRole("button", { name: "Create Blog" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Knowledge Pack"), "kp-1");
    expect(screen.getByRole("button", { name: "Create Blog" })).toBeEnabled();
  });
});
