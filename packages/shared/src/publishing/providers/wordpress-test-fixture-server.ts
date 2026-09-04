import { createServer, type IncomingMessage, type ServerResponse } from "http";

/**
 * Module 9 Phase 9.4 — a deterministic local HTTP fixture server for
 * WordPressChannelProvider tests (Part U: "CI must NOT depend on a
 * public WordPress site... no external internet dependency"). Plain
 * Node `http`, no framework — a `handler` function decides the response
 * for every request, so each test controls exactly what "WordPress"
 * returns.
 */
export interface FixtureRequest {
  method: string;
  path: string;
  authorization?: string;
  body: unknown;
}

export interface FixtureResponse {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
  /** Simulates a connection that never responds within the provider's own timeout — the handler's own promise simply never resolves. */
  hang?: boolean;
}

export type FixtureHandler = (req: FixtureRequest) => FixtureResponse | Promise<FixtureResponse>;

export interface WordPressFixtureServer {
  url: string;
  requests: FixtureRequest[];
  close(): Promise<void>;
}

export async function startWordPressFixtureServer(handler: FixtureHandler): Promise<WordPressFixtureServer> {
  const requests: FixtureRequest[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        let body: unknown;
        try {
          body = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
        } catch {
          body = rawBody;
        }
        const fixtureRequest: FixtureRequest = {
          method: req.method ?? "GET",
          path: req.url ?? "/",
          authorization: req.headers.authorization,
          body,
        };
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
        // Force-close any lingering keep-alive sockets immediately rather
        // than waiting on Node's default keep-alive idle timeout — with
        // many ephemeral fixture servers created across a test run,
        // leaving that to expire naturally is what causes Jest to hang
        // well past the test suite's own reported completion time.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
