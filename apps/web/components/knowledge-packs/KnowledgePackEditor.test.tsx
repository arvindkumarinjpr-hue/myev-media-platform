import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KnowledgePackEditor } from "./KnowledgePackEditor";
import { SessionProvider } from "../../contexts/session-context";
import { makeKnowledgePack } from "../../lib/test-fixtures";
import { mockResponse } from "../../lib/test-mock-response";
import type { KnowledgePackDetail, WorkspaceDetail } from "../../lib/types";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

const workspace = {
  publicId: "ws-1",
  name: "Demo",
  slug: "demo",
  status: "ACTIVE",
  settings: {},
  featureFlags: {},
  myRole: "Owner",
} satisfies WorkspaceDetail;

function renderEditor(pack: KnowledgePackDetail, editable = true, onSaved = jest.fn()) {
  return render(
    <SessionProvider value={{ workspace, permissions: ["KP_UPDATE", "KP_VIEW"] }}>
      <KnowledgePackEditor workspaceId="ws-1" pack={pack} status={pack.status} editable={editable} onSaved={onSaved} />
    </SessionProvider>,
  );
}

function lastPatchBody(spy: jest.SpyInstance): Record<string, unknown> {
  const call = spy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PATCH");
  return JSON.parse((call![1] as RequestInit).body as string);
}

describe("KnowledgePackEditor", () => {
  // global.fetch is a persistent jest.fn() (jest.setup) — its call log
  // outlives restoreAllMocks, so clear it between tests before asserting
  // on the PATCH body.
  beforeEach(() => (global.fetch as jest.Mock).mockClear());
  afterEach(() => jest.restoreAllMocks());

  it("edits the Industry Profile through structured fields and preserves keys the form doesn't know about", async () => {
    const pack = makeKnowledgePack({
      status: "DRAFT",
      lockVersion: 2,
      industryProfile: { industry: "EV", complianceNotes: "keep me", extra: { nested: true } },
    });
    const spy = jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: { ...pack, lockVersion: 3 } }));
    renderEditor(pack);

    const industry = screen.getByLabelText("Industry") as HTMLInputElement;
    expect(industry.value).toBe("EV");
    await userEvent.clear(industry);
    await userEvent.type(industry, "Electric Vehicles");

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(spy.mock.calls.some((c) => (c[1] as RequestInit)?.method === "PATCH")).toBe(true));
    const body = lastPatchBody(spy);
    expect(body.expectedLockVersion).toBe(2);
    expect(body.industryProfile).toEqual({
      industry: "Electric Vehicles",
      complianceNotes: "keep me",
      extra: { nested: true },
    });
  });

  it("edits the Publishing Strategy cadence through a select and keeps other strategy keys", async () => {
    const pack = makeKnowledgePack({
      status: "DRAFT",
      lockVersion: 1,
      publishingStrategy: { cadence: "weekly", channels: ["blog"], notes: "leave alone" },
    });
    const spy = jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: pack }));
    renderEditor(pack);

    await userEvent.selectOptions(screen.getByLabelText("Publishing cadence"), "monthly");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(spy.mock.calls.some((c) => (c[1] as RequestInit)?.method === "PATCH")).toBe(true));
    expect(lastPatchBody(spy).publishingStrategy).toEqual({ cadence: "monthly", channels: ["blog"], notes: "leave alone" });
  });

  it("round-trips the full Industry Profile object through the Advanced JSON editor, including keys the structured form doesn't know about", async () => {
    const pack = makeKnowledgePack({
      status: "DRAFT",
      lockVersion: 1,
      industryProfile: { industry: "EV", region: "India", complianceNotes: "keep me", nested: { a: 1, b: [1, 2, 3] } },
    });
    const spy = jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: pack }));
    renderEditor(pack);

    // Open the Advanced disclosure and confirm it shows the WHOLE object,
    // unknown keys included — not just the structured subset.
    await userEvent.click(screen.getByText(/Advanced — edit the raw industry profile/));
    const raw = screen.getByLabelText("Raw industry profile JSON") as HTMLTextAreaElement;
    expect(JSON.parse(raw.value)).toEqual({ industry: "EV", region: "India", complianceNotes: "keep me", nested: { a: 1, b: [1, 2, 3] } });

    // Edit a structured-known key (industry) directly through the raw
    // editor — the structured "Industry" field above must reflect it.
    const edited = { industry: "Electric Vehicles", region: "India", complianceNotes: "keep me", nested: { a: 1, b: [1, 2, 3] } };
    // userEvent.type() parses "{"/"}" as key-descriptor syntax, which JSON
    // is full of — fireEvent.change is the standard escape hatch for
    // pasting/setting a raw value into a controlled textarea.
    fireEvent.change(raw, { target: { value: JSON.stringify(edited) } });

    await waitFor(() => expect((screen.getByLabelText("Industry", { exact: true }) as HTMLInputElement).value).toBe("Electric Vehicles"));

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(spy.mock.calls.some((c) => (c[1] as RequestInit)?.method === "PATCH")).toBe(true));
    expect(lastPatchBody(spy).industryProfile).toEqual(edited);
  });

  it("adds a Trusted Source and sends the whole collection on save", async () => {
    const pack = makeKnowledgePack({ status: "DRAFT", lockVersion: 1 });
    const spy = jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: pack }));
    renderEditor(pack);

    await userEvent.click(screen.getByRole("tab", { name: /Sources/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add source" }));
    await userEvent.type(screen.getByLabelText("URL"), "https://example.gov");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(spy.mock.calls.some((c) => (c[1] as RequestInit)?.method === "PATCH")).toBe(true));
    expect(lastPatchBody(spy).sources).toEqual([{ sourceType: "GOVERNMENT", url: "https://example.gov" }]);
  });

  it("shows which content types still need a prompt template", async () => {
    const pack = makeKnowledgePack({ status: "DRAFT", promptTemplates: [] });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: pack }));
    renderEditor(pack);

    await userEvent.click(screen.getByRole("tab", { name: /Prompts/ }));
    expect(screen.getByText(/Still missing: Blog, Video, Short, Reel, Newsletter, Social Post/)).toBeInTheDocument();
  });

  it("is fully read-only for a non-editable pack and offers no save bar", () => {
    const pack = makeKnowledgePack({ status: "ACTIVE" });
    renderEditor(pack, false);

    expect((screen.getByLabelText("Name") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.getByText(/Only a Draft version can be edited/)).toBeInTheDocument();
  });

  it("surfaces a stale-lock conflict without overwriting, offering a reload", async () => {
    const pack = makeKnowledgePack({ status: "DRAFT", lockVersion: 1 });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "KNOWLEDGE_CONFLICT", message: "stale" }, 409));
    const onSaved = jest.fn();
    renderEditor(pack, true, onSaved);

    await userEvent.type(screen.getByLabelText("Industry"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const alert = await screen.findByText(/This Knowledge Pack changed elsewhere/);
    expect(alert).toBeInTheDocument();
    expect(within(alert.closest("[role='status'],[role='alert']") ?? document.body).getByRole("button", { name: "Reload latest version" })).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
