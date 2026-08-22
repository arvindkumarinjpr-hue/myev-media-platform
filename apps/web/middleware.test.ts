/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { middleware } from "./middleware";
import { ACCESS_TOKEN_COOKIE } from "./lib/auth-cookies";

describe("middleware auth gate", () => {
  it("redirects an unauthenticated visitor away from /workspaces/* to /login, preserving the intended path", () => {
    const request = new NextRequest("http://localhost:3400/workspaces/abc/knowledge-packs");
    const response = middleware(request);
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/workspaces/abc/knowledge-packs");
  });

  it("lets an authenticated visitor through to /workspaces/*", () => {
    const request = new NextRequest("http://localhost:3400/workspaces/abc/knowledge-packs");
    request.cookies.set(ACCESS_TOKEN_COOKIE, "some-token");
    const response = middleware(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("redirects an already-authenticated visitor away from /login to /workspaces", () => {
    const request = new NextRequest("http://localhost:3400/login");
    request.cookies.set(ACCESS_TOKEN_COOKIE, "some-token");
    const response = middleware(request);
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/workspaces");
  });

  it("lets an unauthenticated visitor reach /login", () => {
    const request = new NextRequest("http://localhost:3400/login");
    const response = middleware(request);
    expect(response.status).toBe(200);
  });
});
