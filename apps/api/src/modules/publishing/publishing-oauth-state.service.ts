import { randomBytes } from "crypto";
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import type { PublishingChannelType } from "../../../generated/prisma";
import type { AppConfig } from "../../config/configuration";

const STATE_TTL_SECONDS = 600; // 10 minutes — an OAuth consent flow should complete in well under this; matches Google/Meta's own typical short-lived-code windows in spirit.
// Meta's discover-then-select step (Part H) hands the operator a real UI
// list to review before committing — a slightly longer window than the
// state TTL above, still short enough that a real page-access-token
// sitting in Redis is a narrow, auto-expiring exposure window, never a
// durable one.
const DISCOVERY_TTL_SECONDS = 900; // 15 minutes
const STATE_BYTES = 32; // 256 bits of entropy, matching TokenService.generateOpaqueToken()'s own convention.

export interface PublishingOAuthState {
  workspaceId: string;
  workspacePublicId: string;
  /** The initiating user's own internal id — never trusted from the callback, only ever read back from what THIS process itself wrote at start-time. */
  userInternalId: string;
  channelType: PublishingChannelType;
}

/** One Meta Page (+ its own optionally-linked Instagram account) discovered right after the OAuth callback, held only long enough for the operator to pick which ones to actually connect (Part H). */
export interface PublishingOAuthDiscoveredPage {
  pageId: string;
  pageName: string;
  pageAccessToken: string;
  instagramBusinessAccountId?: string;
  instagramUsername?: string;
  instagramAccountType?: string;
  /** True only when a linked Instagram account exists AND its own account_type is Business/Creator (Part H — "do not assume personal accounts are publishable"). The Page itself may still be selectable for Facebook even when this is false. */
  instagramEligible: boolean;
}

export interface PublishingOAuthDiscoveryResult {
  workspaceId: string;
  workspacePublicId: string;
  userInternalId: string;
  pages: PublishingOAuthDiscoveredPage[];
}

/**
 * Module 9 Phase 9.7 (Part I) — the ONE place a Meta/YouTube OAuth
 * connect flow's `state` parameter is minted and validated.
 *
 * Migration-checkpoint finding (Part AH item 1): OAuth state is
 * inherently short-lived and single-use by design — it exists only for
 * the few minutes between "operator clicks Connect" and "the provider's
 * redirect lands back on our callback." Redis (already a hard, relied-
 * upon dependency of this process — BullMQ, WorkspaceCacheService,
 * AdaptiveProtectionService all already construct their own client the
 * same way) is the natural fit: native TTL expiry (no cleanup job to
 * write), and `GETDEL` gives genuinely atomic single-use consumption
 * without a second round-trip. `UserActionToken` (the existing Postgres
 * table for password-reset/activation tokens) was considered and
 * rejected — it has no `workspaceId`/provider-binding column, and adding
 * one would be a real migration for a value that is architecturally
 * disposable within minutes. No Postgres migration was needed for this
 * piece.
 *
 * Deliberately FAIL-CLOSED, unlike WorkspaceCacheService's own
 * performance-cache posture: a Redis error while creating or consuming
 * state must reject the OAuth attempt outright (this is a CSRF/session-
 * binding security control, not a cache — "state missing because Redis
 * is down" and "state missing because it's a forged/replayed request"
 * must be indistinguishable to an attacker, and both must fail the same
 * way: no connection is created).
 */
@Injectable()
export class PublishingOAuthStateService implements OnModuleDestroy {
  private readonly logger = new Logger(PublishingOAuthStateService.name);
  private readonly redis: Redis;

  constructor(config: ConfigService<AppConfig, true>) {
    this.redis = new Redis(config.get("redisUrl", { infer: true }), { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
    this.redis.on("error", (err) => {
      this.logger.error({ event: "PUBLISHING_OAUTH_STATE_REDIS_ERROR", err: err.message });
    });
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  private key(state: string): string {
    return `publishing:oauth-state:${state}`;
  }

  /** Mints a fresh, high-entropy, single-use state token bound to this exact workspace/user/channel and persists it. Throws on any Redis failure — never returns a state that wasn't actually durably recorded. */
  async create(input: PublishingOAuthState): Promise<string> {
    const state = randomBytes(STATE_BYTES).toString("base64url");
    // NX: refuses to overwrite an existing key — a cryptographically
    // random 256-bit collision is not a real-world concern, but NX costs
    // nothing and keeps this provably single-write regardless.
    const result = await this.redis.set(this.key(state), JSON.stringify(input), "EX", STATE_TTL_SECONDS, "NX");
    if (result !== "OK") {
      throw new Error("Failed to persist OAuth state.");
    }
    return state;
  }

  /**
   * Atomically reads AND deletes the state in one round-trip (`GETDEL`)
   * — replay-proof by construction: a second callback with the same
   * `state` (a resubmitted browser request, or a genuine replay attempt)
   * finds nothing, because the first successful consumption already
   * removed it. Returns `null` for anything that isn't a clean, valid,
   * unexpired, unconsumed state — the caller treats every `null` alike
   * (a generic "invalid or expired connect link" response), never
   * distinguishing WHY to an unauthenticated caller.
   */
  async consume(state: string): Promise<PublishingOAuthState | null> {
    if (!state || state.length === 0) return null;
    let raw: string | null;
    try {
      // ioredis's typed method set doesn't declare getdel by name on
      // every version pinned here — call() reaches the same atomic
      // GETDEL Redis command directly, still through the one client.
      raw = (await this.redis.call("getdel", this.key(state))) as string | null;
    } catch (err) {
      this.logger.error({ event: "PUBLISHING_OAUTH_STATE_CONSUME_FAILED", err: (err as Error).message });
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as PublishingOAuthState;
      if (!parsed.workspaceId || !parsed.workspacePublicId || !parsed.userInternalId || !parsed.channelType) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private discoveryKey(token: string): string {
    return `publishing:oauth-discovery:${token}`;
  }

  /** Same fail-closed, single-use discipline as create() — used by the Meta OAuth callback to hand the operator's next request (the account-selection UI) the discovered Page/Instagram list without ever putting page access tokens in a URL or a client-visible cookie. */
  async storeDiscovery(result: PublishingOAuthDiscoveryResult): Promise<string> {
    const token = randomBytes(STATE_BYTES).toString("base64url");
    const write = await this.redis.set(this.discoveryKey(token), JSON.stringify(result), "EX", DISCOVERY_TTL_SECONDS, "NX");
    if (write !== "OK") {
      throw new Error("Failed to persist OAuth discovery result.");
    }
    return token;
  }

  /**
   * Read-only peek — NOT single-use, unlike `consume()`: the operator
   * may reload the selection page, or select a subset across more than
   * one request, before the actual "finalize" action (a separate,
   * explicit account-creation call) is what should be single-use. Still
   * workspace-bound: the caller MUST verify the returned `workspaceId`
   * matches the requesting session's own workspace before using it —
   * this method does not do that itself, since it has no request context.
   */
  async peekDiscovery(token: string): Promise<PublishingOAuthDiscoveryResult | null> {
    if (!token) return null;
    let raw: string | null;
    try {
      raw = await this.redis.get(this.discoveryKey(token));
    } catch (err) {
      this.logger.error({ event: "PUBLISHING_OAUTH_DISCOVERY_READ_FAILED", err: (err as Error).message });
      return null;
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PublishingOAuthDiscoveryResult;
    } catch {
      return null;
    }
  }
}
