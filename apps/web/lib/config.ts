// Module 2 Phase 2.6 — the Next.js server (Route Handlers, Server
// Components) is the only thing that ever talks to the backend directly;
// the browser only ever calls this app's own same-origin routes. This is
// the internal, server-to-server URL — never sent to the client.
export function backendUrl(): string {
  return process.env.BACKEND_API_URL ?? "http://localhost:4000";
}
