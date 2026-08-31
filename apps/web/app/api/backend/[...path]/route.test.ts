/**
 * @jest-environment node
 *
 * Route Handlers use next/server's Request/Response Web APIs, which
 * jsdom (this project's default test environment) doesn't provide —
 * Node's own global environment does, natively.
 *
 * Regression coverage for the STAGING UNEXPECTED LOGOUT investigation: the
 * access-token cookie's own Max-Age (900s) matches the backend JWT's TTL
 * exactly, so once it elapses the browser stops sending the cookie
 * entirely — it isn't merely rejected by the backend, it's simply absent
 * from the request this route handler sees. The route previously
 * short-circuited to a 401 the instant `accessToken` was falsy, before
 * ever attempting a refresh — silently defeating the refresh_token retry
 * this same file otherwise fully implements for a present-but-401 access
 * token, and throwing an actively used session to /login roughly every 15
 * minutes despite a perfectly valid, unexpired refresh_token.
 */
import { NextRequest } from "next/server";
import { GET } from "./route";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../../../../lib/auth-cookies";

const mockCookieStore = new Map<string, string>();

jest.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (mockCookieStore.has(name) ? { value: mockCookieStore.get(name) } : undefined),
  }),
}));

function makeRequest(path = "workspaces"): NextRequest {
  return new NextRequest(`https://staging.myevmedia.com/api/backend/${path}`);
}

function jsonResponse(body: unknown, status: number, setCookie?: string): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}

// The GET/POST/... exports are typed Promise<Response> (the base Web API
// type, not NextResponse) — even though a NextResponse is what's actually
// returned at runtime, so its .cookies accessor isn't visible statically.
// Read the same Set-Cookie header the browser itself would see instead.
function setCookieValue(res: Response, name: string): string | undefined {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return raw?.match(new RegExp(`${name}=([^;]+)`))?.[1];
}

describe("GET /api/backend/[...path] — access-token refresh-on-401/absent", () => {
  let fetchSpy: jest.Mock;

  beforeEach(() => {
    mockCookieStore.clear();
    fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  it("passes a valid access token straight through — no refresh attempted", async () => {
    mockCookieStore.set(ACCESS_TOKEN_COOKIE, "valid-access-token");
    fetchSpy.mockResolvedValue(jsonResponse({ data: [] }, 200));

    const res = await GET(makeRequest(), { params: Promise.resolve({ path: ["workspaces"] }) });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("a present-but-rejected access token triggers exactly one refresh, then retries and succeeds (pre-existing behavior, unchanged)", async () => {
    mockCookieStore.set(ACCESS_TOKEN_COOKIE, "expired-access-token");
    mockCookieStore.set(REFRESH_TOKEN_COOKIE, "valid-refresh-token");
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ code: "AUTH_TOKEN_EXPIRED" }, 401)) // first doFetch
      .mockResolvedValueOnce(jsonResponse({ data: { access_token: "new-access-token" } }, 200, `${REFRESH_TOKEN_COOKIE}=new-refresh-token; Path=/`)) // refresh call
      .mockResolvedValueOnce(jsonResponse({ data: [] }, 200)); // retried doFetch

    const res = await GET(makeRequest(), { params: Promise.resolve({ path: ["workspaces"] }) });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(setCookieValue(res, ACCESS_TOKEN_COOKIE)).toBe("new-access-token");
    expect(setCookieValue(res, REFRESH_TOKEN_COOKIE)).toBe("new-refresh-token");
  });

  it("a present-but-rejected access token with no working refresh returns the original 401 (pre-existing behavior, unchanged)", async () => {
    mockCookieStore.set(ACCESS_TOKEN_COOKIE, "expired-access-token");
    // No refresh_token cookie set at all.
    fetchSpy.mockResolvedValueOnce(jsonResponse({ code: "AUTH_TOKEN_EXPIRED" }, 401));

    const res = await GET(makeRequest(), { params: Promise.resolve({ path: ["workspaces"] }) });

    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: an ABSENT access token (browser already purged it past its own Max-Age) still attempts a refresh, and succeeds with a valid refresh_token", async () => {
    mockCookieStore.set(REFRESH_TOKEN_COOKIE, "valid-refresh-token");
    // No access-token cookie set at all — this is the exact browser state
    // once ~900s have elapsed since login/last refresh.
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ data: { access_token: "new-access-token" } }, 200, `${REFRESH_TOKEN_COOKIE}=new-refresh-token; Path=/`)) // refresh call
      .mockResolvedValueOnce(jsonResponse({ data: [{ publicId: "ws-1" }] }, 200)); // retried doFetch

    const res = await GET(makeRequest(), { params: Promise.resolve({ path: ["workspaces"] }) });

    expect(res.status).toBe(200);
    // Exactly two calls: refresh, then the retried request — never a
    // wasted doFetch against a token that was never there.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(setCookieValue(res, ACCESS_TOKEN_COOKIE)).toBe("new-access-token");
    const body = await res.json();
    expect(body.data).toEqual([{ publicId: "ws-1" }]);
  });

  it("an absent access token with no refresh_token either returns AUTH_TOKEN_INVALID 401 (genuinely signed out — unchanged)", async () => {
    const res = await GET(makeRequest(), { params: Promise.resolve({ path: ["workspaces"] }) });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("AUTH_TOKEN_INVALID");
    // No backend call at all — nothing to even attempt refreshing with.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an absent access token with an invalid/expired refresh_token also returns AUTH_TOKEN_INVALID 401", async () => {
    mockCookieStore.set(REFRESH_TOKEN_COOKIE, "stale-refresh-token");
    fetchSpy.mockResolvedValueOnce(jsonResponse({ code: "AUTH_TOKEN_REUSE_DETECTED" }, 401));

    const res = await GET(makeRequest(), { params: Promise.resolve({ path: ["workspaces"] }) });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("AUTH_TOKEN_INVALID");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("still rejects a path-traversal segment before ever touching cookies/fetch", async () => {
    const res = await GET(makeRequest("workspaces/.."), { params: Promise.resolve({ path: ["workspaces", ".."] }) });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
