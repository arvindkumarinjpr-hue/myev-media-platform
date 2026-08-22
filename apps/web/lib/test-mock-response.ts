/** jsdom's test environment has no Fetch API Response/Request globals — this is a minimal stand-in covering exactly what api-client.ts reads (.ok/.status/.json()), used in place of `new Response(...)` across every component test. The cast lives here once instead of at every call site. */
export function mockResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
