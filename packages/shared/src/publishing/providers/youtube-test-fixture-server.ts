import { createServer, type IncomingMessage, type ServerResponse } from "http";

/**
 * Module 9 Phase 9.5 — a deterministic local HTTP fixture server for
 * YouTubeChannelProvider tests (mirrors wordpress-test-fixture-server.ts's
 * own precedent exactly, generalized to capture every request header —
 * unlike WordPress's narrower `authorization`-only capture, YouTube's
 * resumable-upload protocol needs to be tested against `Content-Range`/
 * `X-Upload-Content-Length`/`X-Upload-Content-Type`). CI must have zero
 * dependency on real Google/YouTube endpoints (Part Z) — this is the one
 * fixture every YouTube test uses for both the plain Data API and the
 * resumable-upload endpoint (both are pointed at the SAME fixture
 * instance in tests via `apiBaseUrl`/`uploadBaseUrl`/`oauthTokenEndpoint`
 * overrides).
 */
export interface YouTubeFixtureRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface YouTubeFixtureResponse {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
  /** Simulates a connection that never responds within the provider's own timeout — the handler's own promise simply never resolves. */
  hang?: boolean;
}

export type YouTubeFixtureHandler = (req: YouTubeFixtureRequest) => YouTubeFixtureResponse | Promise<YouTubeFixtureResponse>;

export interface YouTubeFixtureServer {
  url: string;
  requests: YouTubeFixtureRequest[];
  close(): Promise<void>;
}

export async function startYouTubeFixtureServer(handler: YouTubeFixtureHandler): Promise<YouTubeFixtureServer> {
  const requests: YouTubeFixtureRequest[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const rawBody = Buffer.concat(chunks);
        const contentType = req.headers["content-type"] ?? "";
        let body: unknown;
        if (rawBody.length === 0) {
          body = undefined;
        } else if (typeof contentType === "string" && contentType.includes("application/json")) {
          try {
            body = JSON.parse(rawBody.toString("utf8"));
          } catch {
            body = rawBody.toString("utf8");
          }
        } else {
          // Binary upload chunk (or form-urlencoded OAuth body) — keep as a Buffer so tests can assert exact byte content/length.
          body = rawBody;
        }
        const fixtureRequest: YouTubeFixtureRequest = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body };
        requests.push(fixtureRequest);

        const result = await handler(fixtureRequest);
        if (result.hang) return; // Deliberately never respond — the client's own AbortController timeout is what ends this.

        res.writeHead(result.status, { "Content-Type": "application/json", ...result.headers });
        res.end(result.json !== undefined ? JSON.stringify(result.json) : "");
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server failed to bind to a port.");

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
