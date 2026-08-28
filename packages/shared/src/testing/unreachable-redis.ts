/**
 * Module 6 Phase 6.5-A — the ONE deterministically-unreachable Redis URL
 * every "Redis unavailable" e2e test uses.
 *
 * `127.0.0.1` is a loopback literal, so the OS resolver is never
 * consulted — the earlier `redis://redis:1` depended on a hostname that
 * a GitHub runner sometimes failed to resolve with a *transient*
 * `EAI_AGAIN` instead of a *permanent* `ENOTFOUND`, and under `EAI_AGAIN`
 * ioredis kept retrying DNS forever, leaving lookup timers/handles alive
 * and making the shutdown/leak assertions flaky.
 *
 * Port `1` (`tcpmux`) is privileged and has no listener in any CI or
 * container environment, so every connection attempt fails immediately
 * and deterministically with `ECONNREFUSED` — which ioredis's default
 * `retryStrategy` retries exactly the way the unreachable-Redis tests
 * expect ("connect, refuse, retry"), just without any DNS dependency.
 *
 * This is TEST-ONLY. Production Redis retry / reconnect / recovery
 * behaviour is unchanged — only the URL these specific tests point at.
 */
export const UNREACHABLE_REDIS_URL = "redis://127.0.0.1:1";
