import { render, screen, waitFor } from "@testing-library/react";
import { ProjectList } from "./ProjectList";
import { mockResponse } from "../../lib/test-mock-response";

function mockBackend(projects: unknown[], packs: unknown[] = []) {
  jest.spyOn(global, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/knowledge-packs")) return Promise.resolve(mockResponse({ data: packs }));
    if (url.includes("/projects")) return Promise.resolve(mockResponse({ data: projects }));
    return Promise.resolve(mockResponse({ data: [] }));
  });
}

describe("ProjectList", () => {
  afterEach(() => jest.restoreAllMocks());

  it("shows a loading state, then the list with resolved Knowledge Pack names", async () => {
    mockBackend(
      [{ publicId: "p-1", name: "Consumer Blog", slug: "consumer-blog", status: "ACTIVE", knowledgePackPublicId: "kp-1" }],
      [{ publicId: "kp-1", name: "EV Pack", status: "ACTIVE", versionNumber: 2 }],
    );
    render(<ProjectList workspaceId="ws-1" />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Consumer Blog")).toBeInTheDocument());
    expect(screen.getByText(/EV Pack \(v2\)/)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("shows an Unassigned badge for a Project with no Knowledge Pack", async () => {
    mockBackend([{ publicId: "p-1", name: "YouTube Channel", slug: "youtube", status: "ACTIVE", knowledgePackPublicId: null }]);
    render(<ProjectList workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByText("Unassigned")).toBeInTheDocument());
  });

  it("shows an empty state with no fabricated create action", async () => {
    mockBackend([]);
    render(<ProjectList workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByText("No Projects yet")).toBeInTheDocument());
  });

  it("shows an error state with retry on failure", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "SERVER_ERROR", message: "boom" }, 500));
    render(<ProjectList workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });
});
