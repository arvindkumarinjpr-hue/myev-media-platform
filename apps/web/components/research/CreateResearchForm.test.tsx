import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateResearchForm } from "./CreateResearchForm";
import { mockResponse } from "../../lib/test-mock-response";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

describe("CreateResearchForm", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    push.mockClear();
  });

  it("submits a topic + Knowledge Pack and navigates to the research detail page", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(mockResponse({ data: [{ publicId: "kp-1", name: "EV Pack", status: "ACTIVE", versionNumber: 1 }] }))
      .mockResolvedValueOnce(mockResponse({ data: { publicId: "res-new", status: "QUEUED" } }, 202));

    render(<CreateResearchForm workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByLabelText("Topic")).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText("Topic"), "EV battery swap stations");
    await userEvent.selectOptions(screen.getByLabelText("Knowledge Pack"), "kp-1");
    await userEvent.click(screen.getByRole("button", { name: "Start Research" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/workspaces/ws-1/research/res-new"));
  });

  it("shows a message instead of the form when there is no ACTIVE Knowledge Pack", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [{ publicId: "kp-1", name: "Draft Pack", status: "DRAFT", versionNumber: 1 }] }));
    render(<CreateResearchForm workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByText("No active Knowledge Pack")).toBeInTheDocument());
    expect(screen.queryByLabelText("Topic")).not.toBeInTheDocument();
  });

  it("disables submit until both topic and Knowledge Pack are set", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [{ publicId: "kp-1", name: "EV Pack", status: "ACTIVE", versionNumber: 1 }] }));
    render(<CreateResearchForm workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start Research" })).toBeDisabled());
    await userEvent.type(screen.getByLabelText("Topic"), "topic");
    expect(screen.getByRole("button", { name: "Start Research" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Knowledge Pack"), "kp-1");
    expect(screen.getByRole("button", { name: "Start Research" })).toBeEnabled();
  });
});
