import { createServer, type IncomingMessage, type ServerResponse } from "http";

/**
 * Module 9 Phase 9.6 — a deterministic local HTTP fixture server for
 * FacebookChannelProvider/InstagramChannelProvider tests, mirroring
 * youtube-test-fixture-server.ts's own precedent exactly. Both providers'
 * `graphBaseUrl`/`uploadBaseUrl` test overrides point at ONE instance of
 * this fixture (Part AA/AB/Z: "No Meta internet dependency").
 */
export interface MetaFixtureRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface MetaFixtureResponse {
  status: number;
  json?: unknown;
  hang?: boolean;
}

export type MetaFixtureHandler = (req: MetaFixtureRequest) => MetaFixtureResponse | Promise<MetaFixtureResponse>;

export interface MetaFixtureServer {
  url: string;
  requests: MetaFixtureRequest[];
  close(): Promise<void>;
}

export async function startMetaFixtureServer(handler: MetaFixtureHandler): Promise<MetaFixtureServer> {
  const requests: MetaFixtureRequest[] = [];

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
        } else if (typeof contentType === "string" && contentType.includes("application/x-www-form-urlencoded")) {
          body = Object.fromEntries(new URLSearchParams(rawBody.toString("utf8")));
        } else {
          // Binary media-upload body (rupload.facebook.com) — kept as a
          // Buffer so tests can assert exact byte content/length.
          body = rawBody;
        }
        const fixtureRequest: MetaFixtureRequest = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body };
        requests.push(fixtureRequest);

        const result = await handler(fixtureRequest);
        if (result.hang) return;

        res.writeHead(result.status, { "Content-Type": "application/json" });
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
