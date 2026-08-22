import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfigurationEditor } from "./ConfigurationEditor";
import { makeKnowledgePack } from "../../lib/test-fixtures";
import { mockResponse } from "../../lib/test-mock-response";

describe("ConfigurationEditor", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("Draft: fields are editable and Save persists via PATCH with the current lockVersion", async () => {
    const pack = makeKnowledgePack({ status: "DRAFT", lockVersion: 3 });
    const onSaved = jest.fn();
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: { ...pack, name: "Renamed", lockVersion: 4 } }));

    render(<ConfigurationEditor workspaceId="ws-1" pack={pack} editable onSaved={onSaved} />);
    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    expect(nameInput.readOnly).toBe(false);

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.expectedLockVersion).toBe(3);
    expect(body.name).toBe("Renamed");
  });

  it("Active: fields render read-only and there is no Save button", () => {
    const pack = makeKnowledgePack({ status: "ACTIVE" });
    render(<ConfigurationEditor workspaceId="ws-1" pack={pack} editable={false} onSaved={jest.fn()} />);

    expect((screen.getByLabelText("Name") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.getByText(/Create a new version to make changes/)).toBeInTheDocument();
  });

  it("shows a clear conflict message on a stale lockVersion (409 KNOWLEDGE_CONFLICT), never silently overwriting", async () => {
    const pack = makeKnowledgePack({ status: "DRAFT", lockVersion: 1 });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "KNOWLEDGE_CONFLICT", message: "stale" }, 409));
    const onSaved = jest.fn();

    render(<ConfigurationEditor workspaceId="ws-1" pack={pack} editable onSaved={onSaved} />);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(/changed elsewhere since you loaded it/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
