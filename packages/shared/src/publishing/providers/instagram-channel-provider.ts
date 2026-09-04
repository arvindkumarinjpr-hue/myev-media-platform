import { PublishingProviderPermanentError, PublishingProviderRetryableError } from "../publishing-provider-error";
import type {
  PublishingChannelCapabilities,
  PublishingChannelProvider,
  PublishingConnectionCheckInput,
  PublishingConnectionValidationResult,
  PublishingExecutionCallbacks,
  PublishingPublishInput,
  PublishingPublishResult,
} from "../publishing-provider.interface";
import { classifyMetaGraphFailure, MetaGraphClient, type MetaGraphClientOptions } from "./meta-graph-client";
import { parseMetaCredential, type MetaCredentialPayload } from "./meta-credential";

// Meta's own documented guidance: "query a container's status once per
// minute, for no more than 5 minutes." A single publishing.execute.v1
// attempt has a 120s timeout (Part N) — polling for the full 5 minutes
// in-process would blow that budget, so this connector polls a SHORT,
// budget-safe number of times locally, then — if still IN_PROGRESS —
// saves a checkpoint and throws retryable, letting the EXISTING outer
// Phase 9.3 retry/backoff system re-enter publish() later and resume
// polling the SAME container rather than creating a new one. No
// in-process unbounded loop; no new polling infrastructure.
const LOCAL_POLL_ATTEMPTS = 5;
const LOCAL_POLL_INTERVAL_MS = 3_000;

interface InstagramUploadCheckpoint {
  containerId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isInstagramUploadCheckpoint(value: unknown): value is InstagramUploadCheckpoint {
  return isRecord(value) && typeof value.containerId === "string" && value.containerId.length > 0;
}

export type InstagramChannelProviderOptions = MetaGraphClientOptions;

/**
 * Module 9 Phase 9.6 — the mechanical Instagram Reels publishing
 * connector. Framework-free, mirrors FacebookChannelProvider/
 * YouTubeChannelProvider's own shape. Unlike Facebook, Instagram's
 * container/status_code mechanism gives a REAL, documented crash/
 * duplicate-reconciliation path (Part P research finding): a container
 * that already reached PUBLISHED tells a later attempt, authoritatively,
 * never to call media_publish again — the one genuine gap is that the
 * resulting media id cannot always be recovered in that narrow race (see
 * `publish()`'s own PUBLISHED-branch comment and the Phase 9.6 report's
 * own Part 22).
 *
 * No public `video_url` media-delivery path is used (Part K) — this
 * connector always uses Instagram's resumable direct-upload
 * (`upload_type: "resumable"` + `rupload.facebook.com`), so it never
 * needs to expose a short-lived public MinIO URL and never inherits that
 * whole class of expiry/replay/leakage risk.
 */
export class InstagramChannelProvider implements PublishingChannelProvider {
  readonly channelType = "INSTAGRAM" as const;
  private readonly client: MetaGraphClient;

  constructor(options: InstagramChannelProviderOptions = {}) {
    this.client = new MetaGraphClient(options);
  }

  getCapabilities(): PublishingChannelCapabilities {
    return {
      supportedContentTypes: ["VIDEO"],
      requiresRenderedMedia: true,
      requiresTitle: false,
      requiresDescription: false,
      supportsTags: false,
      supportsCaption: true,
      // No privacy concept — a published Reel is live to the connected
      // professional account's own audience by definition (Part Y).
      supportedPrivacyOptions: undefined,
    };
  }

  async validateConnection(input: PublishingConnectionCheckInput): Promise<PublishingConnectionValidationResult> {
    const credential = this.parseCredential(input.decryptedCredential);
    if (!credential || !credential.igUserId) {
      return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "Stored Instagram credential is missing required fields." };
    }
    // Confirms the token resolves to the expected professional account —
    // account_type distinguishes a genuinely publishable Business/Creator
    // account from a personal one (Part T/I: "Do not assume ordinary
    // Instagram personal accounts are publishable").
    const { status, json } = await this.client.graphRequest("GET", `/${credential.igUserId}?fields=id,account_type`, credential.accessToken);
    if (status < 200 || status >= 300) return this.classifyConnectionFailure(status, json);
    if (!isRecord(json) || (json.account_type !== "BUSINESS" && json.account_type !== "MEDIA_CREATOR")) {
      return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "The connected Instagram account is not a Business/Creator professional account." };
    }
    return { healthy: true };
  }

  async publish(input: PublishingPublishInput, decryptedCredential: Record<string, unknown>, callbacks?: PublishingExecutionCallbacks): Promise<PublishingPublishResult> {
    if (input.contentType !== "VIDEO") {
      throw new PublishingProviderPermanentError("INSTAGRAM_UNSUPPORTED_CONTENT_TYPE", `Instagram does not support publishing content type "${input.contentType}".`);
    }
    const credential = this.parseCredential(decryptedCredential);
    if (!credential || !credential.igUserId) {
      throw new PublishingProviderPermanentError("INSTAGRAM_CREDENTIAL_INVALID", "Stored Instagram credential is missing required fields.");
    }
    if (!input.artifact) {
      throw new PublishingProviderPermanentError("INSTAGRAM_ARTIFACT_MISSING", "No resolved video artifact was provided to publish.");
    }
    if (!callbacks?.mediaReader) {
      throw new PublishingProviderPermanentError("INSTAGRAM_MEDIA_READER_MISSING", "No media reader was supplied for this VIDEO publish.");
    }
    const mediaReader = callbacks.mediaReader;
    const mediaAssetPublicId = input.artifact.mediaAssetPublicId;

    const prior = isInstagramUploadCheckpoint(input.priorCheckpoint) ? input.priorCheckpoint : null;
    const containerId = prior ? prior.containerId : await this.createContainerAndUpload(credential, mediaAssetPublicId, mediaReader, callbacks, input.metadata.caption);

    const pollOutcome = await this.pollContainerStatus(credential, containerId);

    if (pollOutcome.status === "IN_PROGRESS") {
      // Checkpoint already saved (either just now, or by the prior
      // attempt) — the outer retry system resumes polling this SAME
      // container; never a second container/upload.
      throw new PublishingProviderRetryableError("INSTAGRAM_PROCESSING_NOT_READY", "Instagram is still processing the uploaded media.");
    }
    if (pollOutcome.status === "ERROR") {
      throw new PublishingProviderPermanentError("INSTAGRAM_MEDIA_PROCESSING_FAILED", "Instagram reported an error processing the uploaded media.");
    }
    if (pollOutcome.status === "EXPIRED") {
      // The container genuinely died without ever being published — the
      // one case provably safe to start completely fresh (mirrors
      // YouTube's 404-on-checkpoint precedent exactly).
      const freshContainerId = await this.createContainerAndUpload(credential, mediaAssetPublicId, mediaReader, callbacks, input.metadata.caption);
      const freshPoll = await this.pollContainerStatus(credential, freshContainerId);
      if (freshPoll.status !== "FINISHED") {
        throw new PublishingProviderRetryableError("INSTAGRAM_PROCESSING_NOT_READY", "Instagram is still processing the newly re-uploaded media.");
      }
      return this.publishContainer(credential, freshContainerId);
    }
    if (pollOutcome.status === "PUBLISHED") {
      // Research finding (Part P/22): the container reaching PUBLISHED
      // authoritatively proves media_publish already succeeded on a
      // PRIOR attempt (this attempt never calls it — no duplicate risk),
      // but Meta's API documents no way to recover the resulting media id
      // from an already-published container. Never fabricated — this
      // requires a human to look up the actual post and reconcile.
      throw new PublishingProviderPermanentError(
        "INSTAGRAM_PUBLISHED_ID_UNRECOVERABLE",
        "This container was already published by a previous attempt, but the resulting media id could not be recovered. Manual verification is required.",
      );
    }
    // FINISHED
    return this.publishContainer(credential, containerId);
  }

  private async createContainerAndUpload(
    credential: MetaCredentialPayload,
    mediaAssetPublicId: string,
    mediaReader: NonNullable<PublishingExecutionCallbacks["mediaReader"]>,
    callbacks: PublishingExecutionCallbacks,
    caption?: string,
  ): Promise<string> {
    const head = await mediaReader.headObject(mediaAssetPublicId);
    const { status, json } = await this.client.graphRequest("POST", `/${credential.igUserId}/media`, credential.accessToken, {
      media_type: "REELS",
      upload_type: "resumable",
      ...(caption ? { caption } : {}),
    });
    if (status < 200 || status >= 300 || !isRecord(json) || typeof json.id !== "string") {
      throw classifyMetaGraphFailure(status, json, "media container create");
    }
    const containerId = json.id;
    // Saved BEFORE any byte upload (mirrors YouTube's own discipline) —
    // once a container exists, every later attempt resumes via THIS
    // container rather than ever creating a second one.
    await callbacks.saveCheckpoint({ containerId } satisfies InstagramUploadCheckpoint);

    // Instagram's documented resumable-upload path has no per-chunk
    // continuation protocol (unlike YouTube's 308/Range mechanism) — the
    // whole object is read via the SAME bounded-range MediaReader seam
    // (never a raw storage-SDK stream) and sent as one upload request.
    // Bounded is still meaningful here: Reels content is realistically
    // small (Instagram itself caps eligible Reels at 90s), so this never
    // approaches Module 7's 2GB ceiling in practice, but the read still
    // goes through the same seam every other connector uses.
    const bytes = await mediaReader.readRange(mediaAssetPublicId, 0, head.sizeBytes - 1);
    const { status: uploadStatus, json: uploadJson } = await this.client.uploadRequest(`/ig-api-upload/${containerId}`, credential.accessToken, bytes, {
      offset: "0",
      file_size: String(head.sizeBytes),
    });
    if (uploadStatus < 200 || uploadStatus >= 300) {
      throw classifyMetaGraphFailure(uploadStatus, uploadJson, "media upload");
    }
    return containerId;
  }

  private async pollContainerStatus(credential: MetaCredentialPayload, containerId: string): Promise<{ status: "FINISHED" | "IN_PROGRESS" | "ERROR" | "EXPIRED" | "PUBLISHED" }> {
    for (let attempt = 0; attempt < LOCAL_POLL_ATTEMPTS; attempt++) {
      const { status, json } = await this.client.graphRequest("GET", `/${containerId}?fields=status_code`, credential.accessToken);
      if (status < 200 || status >= 300 || !isRecord(json) || typeof json.status_code !== "string") {
        throw classifyMetaGraphFailure(status, json, "container status check");
      }
      const statusCode = json.status_code;
      if (statusCode === "FINISHED" || statusCode === "ERROR" || statusCode === "EXPIRED" || statusCode === "PUBLISHED") {
        return { status: statusCode };
      }
      if (attempt < LOCAL_POLL_ATTEMPTS - 1) await this.sleep(LOCAL_POLL_INTERVAL_MS);
    }
    return { status: "IN_PROGRESS" };
  }

  private async publishContainer(credential: MetaCredentialPayload, containerId: string): Promise<PublishingPublishResult> {
    const { status, json } = await this.client.graphRequest("POST", `/${credential.igUserId}/media_publish`, credential.accessToken, { creation_id: containerId });
    if (status < 200 || status >= 300 || !isRecord(json) || typeof json.id !== "string") {
      throw classifyMetaGraphFailure(status, json, "media publish");
    }
    const mediaId = json.id;
    // Follow-up read (Part Z) — media_publish's own response does not
    // include the permalink.
    const permalink = await this.fetchPermalink(credential, mediaId);
    return { externalContentId: mediaId, externalUrl: permalink };
  }

  private async fetchPermalink(credential: MetaCredentialPayload, mediaId: string): Promise<string | undefined> {
    const { status, json } = await this.client.graphRequest("GET", `/${mediaId}?fields=permalink`, credential.accessToken);
    if (status < 200 || status >= 300 || !isRecord(json) || typeof json.permalink !== "string") return undefined;
    return json.permalink;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private parseCredential(raw: Record<string, unknown>): MetaCredentialPayload | null {
    return parseMetaCredential(raw);
  }

  private classifyConnectionFailure(status: number, json: unknown): PublishingConnectionValidationResult {
    const failure = classifyMetaGraphFailure(status, json, "connection check");
    if (failure instanceof PublishingProviderRetryableError) return { healthy: false, reasonCode: "PROVIDER_UNAVAILABLE", detail: "Meta Graph API is temporarily unavailable." };
    if (failure.errorCode === "META_UNAUTHORIZED") return { healthy: false, reasonCode: "CREDENTIAL_REVOKED", detail: "Instagram rejected the stored credential (unauthorized)." };
    if (failure.errorCode === "META_INSUFFICIENT_PERMISSION") return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "The granted Instagram permissions are insufficient." };
    return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "Instagram rejected the credential." };
  }
}
