import { HttpResearchSourceProvider } from "./http-research-source-provider.service";

describe("HttpResearchSourceProvider", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("marks a source reachable on a successful response", async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 200 });
    const provider = new HttpResearchSourceProvider();
    const result = await provider.checkReachable([{ url: "https://example.gov", sourceType: "GOVERNMENT" }]);
    expect(result).toEqual([{ url: "https://example.gov", sourceType: "GOVERNMENT", reachable: true }]);
  });

  it("still marks reachable when the server returns 404/405 (the server itself answered)", async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 405 });
    const provider = new HttpResearchSourceProvider();
    const result = await provider.checkReachable([{ url: "https://example.gov", sourceType: "GOVERNMENT" }]);
    expect(result[0]?.reachable).toBe(true);
  });

  it("marks unreachable on a 5xx server error", async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 503 });
    const provider = new HttpResearchSourceProvider();
    const result = await provider.checkReachable([{ url: "https://example.gov", sourceType: "GOVERNMENT" }]);
    expect(result[0]?.reachable).toBe(false);
  });

  it("marks unreachable on a network error — never throws, per FR-RES-002's own 'not a hard failure' error condition", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const provider = new HttpResearchSourceProvider();
    const result = await provider.checkReachable([{ url: "https://unreachable.example", sourceType: "NEWS" }]);
    expect(result[0]?.reachable).toBe(false);
  });

  it("checks every source independently, one failure does not affect another's result", async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => (url.includes("good") ? Promise.resolve({ status: 200 }) : Promise.reject(new Error("network error"))));
    const provider = new HttpResearchSourceProvider();
    const result = await provider.checkReachable([
      { url: "https://good.example", sourceType: "NEWS" },
      { url: "https://bad.example", sourceType: "NEWS" },
    ]);
    expect(result.find((r) => r.url === "https://good.example")?.reachable).toBe(true);
    expect(result.find((r) => r.url === "https://bad.example")?.reachable).toBe(false);
  });
});
