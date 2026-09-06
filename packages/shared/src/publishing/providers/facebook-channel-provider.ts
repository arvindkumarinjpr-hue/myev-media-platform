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

const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8 MiB — same conservative default as YouTubeChannelProvider, for the identical memory-safety reason (Part K/N).

export interface FacebookChannelProviderOptions extends MetaGraphClientOptions {
  /** Meta's own registered App id — required by the `/APP_ID/uploads` resumable-upload session endpoint. A platform-level constant (Part AD), never a per-workspace credential field. */
  appId: string;
  chunkSizeBytes?: number;
}

/**
 * The ONE non-secret marker persisted via `saveCheckpoint()` for a
 * Facebook publish attempt. `phase` is the critical field:
 * "UPLOAD_SESSION" means only the (safely resumable) byte-transfer has
 * started — retrying is safe. "PAGE_POST_ATTEMPTED" means the ONE
 * non-idempotent call (`POST /PAGE_ID/videos`, which actually creates the
 * Page post) has been sent and its outcome is unknown — Part P research
 * finding: Meta's Graph API documents no idempotency key, no client-
 * generated request id, and no query to ask "was a Page video already
 * created from this upload session" for that specific call. Retrying it
 * blindly risks creating a second Page post. So once this marker exists,
 * `publish()` NEVER calls that endpoint again for this target — it fails
 * permanently, requiring a human to verify Facebook directly and manually
 * reconcile the PublicationTarget. This is a deliberate, conservative
 * "never risk a duplicate, at the cost of full automatic self-healing"
 * design — not a stand-in for a real reconciliation mechanism that
 * doesn't exist (see the Phase 9.6 completion report's own Part 21).
 */
interface FacebookUploadCheckpoint {
  phase: "UPLOAD_SESSION" | "PAGE_POST_ATTEMPTED";
  uploadSessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isFacebookUploadCheckpoint(value: unknown): value is FacebookUploadCheckpoint {
  return isRecord(value) && (value.phase === "UPLOAD_SESSION" || value.phase === "PAGE_POST_ATTEMPTED") && typeof value.uploadSessionId === "string" && value.uploadSessionId.length > 0;
}

/**
 * Module 10 Phase 10.5 — the marker for a SOCIAL_POST text/photo publish,
 * whose external call (`/PAGE_ID/feed` or `/PAGE_ID/photos`) is a single
 * atomic request with no preceding upload-session step to distinguish
 * "never attempted" from "attempted, outcome unknown" — unlike the video
 * path's own two-phase checkpoint. Same conservative discipline as
 * FacebookUploadCheckpoint's own PAGE_POST_ATTEMPTED: once this exists,
 * publish() never repeats the call, since Meta's API documents no
 * idempotency key for either endpoint (same Part P research finding this
 * class's own doc comment already cites for the video path).
 */
interface FacebookSocialPostCheckpoint {
  phase: "SOCIAL_POST_ATTEMPTED";
}

export function isFacebookSocialPostCheckpoint(value: unknown): value is FacebookSocialPostCheckpoint {
  return isRecord(value) && value.phase === "SOCIAL_POST_ATTEMPTED";
}

/**
 * Module 9 Phase 9.6 — the mechanical Facebook Page video publishing
 * connector. Framework-free (no NestJS, no Prisma), mirroring
 * YouTubeChannelProvider's own shape exactly. No OAuth refresh (Part F
 * research finding: a Page access token derived from a long-lived User
 * token has no expiry of its own). No privacy/visibility concept exposed
 * (Part Y research finding: a Page video post created via this mechanical
 * flow is immediately live to the Page's own audience by default — Meta
 * does expose `unpublished_content_type`/`scheduled_publish_time`
 * parameters, but exposing either here would duplicate Module 9's own
 * already-authoritative scheduler, so neither is used).
 */
export class FacebookChannelProvider implements PublishingChannelProvider {
  readonly channelType = "FACEBOOK" as const;
  private readonly client: MetaGraphClient;
  private readonly appId: string;
  private readonly chunkSizeBytes: number;

  constructor(options: FacebookChannelProviderOptions) {
    this.client = new MetaGraphClient(options);
    this.appId = options.appId;
    this.chunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
  }

  getCapabilities(): PublishingChannelCapabilities {
    return {
      // Module 10 Phase 10.5 — SOCIAL_POST added: Facebook Pages can post
      // caption-only (a plain Page feed post, `/PAGE_ID/feed`) or with an
      // attached photo/video, so media is OPTIONAL — see publish()'s own
      // SOCIAL_POST branch.
      supportedContentTypes: ["VIDEO", "SOCIAL_POST"],
      requiresRenderedMedia: true,
      requiresTitle: false,
      requiresDescription: false,
      supportsTags: false,
      supportsCaption: true,
      socialPostMediaRequirement: "OPTIONAL",
      // No privacy concept exposed — see class doc comment.
      supportedPrivacyOptions: undefined,
    };
  }

  async validateConnection(input: PublishingConnectionCheckInput): Promise<PublishingConnectionValidationResult> {
    const credential = this.parseCredential(input.decryptedCredential);
    if (!credential || !credential.pageId) {
      return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "Stored Facebook credential is missing required fields." };
    }
    // Minimal, read-only "whoami" against the connected Page — confirms
    // the token is live and actually resolves to the expected Page,
    // without publishing anything (Part T).
    const { status, json } = await this.client.graphRequest("GET", `/${credential.pageId}?fields=id`, credential.accessToken);
    if (status >= 200 && status < 300) return { healthy: true };
    return this.classifyConnectionFailure(status, json);
  }

  async publish(input: PublishingPublishInput, decryptedCredential: Record<string, unknown>, callbacks?: PublishingExecutionCallbacks): Promise<PublishingPublishResult> {
    const credential = this.parseCredential(decryptedCredential);
    if (!credential || !credential.pageId) {
      throw new PublishingProviderPermanentError("FACEBOOK_CREDENTIAL_INVALID", "Stored Facebook credential is missing required fields.");
    }

    // Module 10 Phase 10.5 — SOCIAL_POST branch, kept structurally
    // separate from the VIDEO path below rather than interleaved with it
    // (Part F: "keep it minimal and demonstrate why" — a caption-only or
    // photo social post shares none of VIDEO's resumable-upload/
    // checkpoint mechanics, so branching early avoids threading
    // SOCIAL_POST-only logic through code that must stay byte-identical
    // for VIDEO).
    if (input.contentType === "SOCIAL_POST") {
      return this.publishSocialPost(input, credential, callbacks);
    }
    if (input.contentType !== "VIDEO") {
      throw new PublishingProviderPermanentError("FACEBOOK_UNSUPPORTED_CONTENT_TYPE", `Facebook does not support publishing content type "${input.contentType}".`);
    }
    if (!input.artifact) {
      throw new PublishingProviderPermanentError("FACEBOOK_ARTIFACT_MISSING", "No resolved video artifact was provided to publish.");
    }
    if (!callbacks?.mediaReader) {
      throw new PublishingProviderPermanentError("FACEBOOK_MEDIA_READER_MISSING", "No media reader was supplied for this VIDEO publish.");
    }
    return this.publishVideoArtifact(credential, input.artifact.mediaAssetPublicId, input.priorCheckpoint, callbacks, input.metadata.caption);
  }

  private async publishVideoArtifact(
    credential: MetaCredentialPayload,
    mediaAssetPublicId: string,
    priorCheckpoint: Record<string, unknown> | undefined,
    callbacks: PublishingExecutionCallbacks,
    caption: string | undefined,
  ): Promise<PublishingPublishResult> {
    const mediaReader = callbacks.mediaReader!;
    const prior = isFacebookUploadCheckpoint(priorCheckpoint) ? priorCheckpoint : null;
    if (prior?.phase === "PAGE_POST_ATTEMPTED") {
      // The one non-idempotent call may or may not have succeeded on
      // Facebook's side — see class doc comment. Never retried blindly.
      throw new PublishingProviderPermanentError(
        "FACEBOOK_PUBLISH_OUTCOME_UNKNOWN",
        "A previous attempt already invoked Facebook's page-video-post creation and its outcome could not be confirmed; refusing to retry to avoid a duplicate post. Manual verification is required.",
      );
    }

    const head = await mediaReader.headObject(mediaAssetPublicId);
    const uploadSessionId = prior?.uploadSessionId ?? (await this.createUploadSession(credential, head.sizeBytes, head.contentType));
    if (!prior) {
      await callbacks.saveCheckpoint({ phase: "UPLOAD_SESSION", uploadSessionId } satisfies FacebookUploadCheckpoint);
    }

    const fileHandle = await this.transferBytes(credential, uploadSessionId, head.sizeBytes, mediaAssetPublicId, mediaReader);

    // The point of no return — see FacebookUploadCheckpoint's own doc
    // comment. Saved BEFORE the call, exactly like YouTube's own
    // save-before-upload discipline, so a crash between this write and
    // the call landing on Facebook's servers still blocks a blind retry.
    await callbacks.saveCheckpoint({ phase: "PAGE_POST_ATTEMPTED", uploadSessionId } satisfies FacebookUploadCheckpoint);

    return this.createPageVideoPost(credential, fileHandle, caption);
  }

  /**
   * Module 10 Phase 10.5 Part F — the genuine executable path for
   * SOCIAL_POST + FACEBOOK + caption-only: a plain Page feed text post
   * (`/PAGE_ID/feed`), never routed through the video-upload endpoint.
   * When a media attachment IS present, a VIDEO-typed asset reuses the
   * EXISTING resumable-upload machinery verbatim (publishVideoArtifact) —
   * mechanically identical to a plain VIDEO publish, safe to ship as-is.
   * An IMAGE-typed asset is deliberately NOT implemented this phase: a
   * real Facebook photo post (`/PAGE_ID/photos`) requires a genuine
   * multipart/form-data file upload against the plain Graph host, a
   * protocol this codebase's MetaGraphClient has no primitive for today
   * (its own `uploadRequest` targets ONLY the separate rupload.facebook.com
   * resumable-upload host, a different protocol video/Instagram use) —
   * this is the Part F "existing provider/API abstractions [cannot]
   * support it safely within this phase" case, disclosed rather than
   * shipped as a silently-broken call. Readiness still resolves an
   * IMAGE-typed artifact as ready (Facebook's own media requirement is
   * OPTIONAL either way), so this gap surfaces as an honest permanent
   * execution failure, never a false, silent success.
   */
  private async publishSocialPost(input: PublishingPublishInput, credential: MetaCredentialPayload, callbacks?: PublishingExecutionCallbacks): Promise<PublishingPublishResult> {
    const caption = input.metadata.caption;
    if (!input.artifact) {
      return this.publishSocialFeedPost(credential, caption, input.priorCheckpoint, callbacks);
    }
    if (!callbacks?.mediaReader) {
      throw new PublishingProviderPermanentError("FACEBOOK_MEDIA_READER_MISSING", "No media reader was supplied for this SOCIAL_POST media publish.");
    }
    const head = await callbacks.mediaReader.headObject(input.artifact.mediaAssetPublicId);
    if (head.contentType?.startsWith("video/")) {
      return this.publishVideoArtifact(credential, input.artifact.mediaAssetPublicId, input.priorCheckpoint, callbacks, caption);
    }
    throw new PublishingProviderPermanentError(
      "FACEBOOK_SOCIAL_IMAGE_NOT_YET_SUPPORTED",
      "Publishing a SOCIAL_POST with an attached image to Facebook is not yet implemented — this requires multipart file upload support this connector does not have today.",
    );
  }

  private async publishSocialFeedPost(
    credential: MetaCredentialPayload,
    caption: string | undefined,
    priorCheckpoint: Record<string, unknown> | undefined,
    callbacks?: PublishingExecutionCallbacks,
  ): Promise<PublishingPublishResult> {
    if (isFacebookSocialPostCheckpoint(priorCheckpoint)) {
      throw new PublishingProviderPermanentError(
        "FACEBOOK_PUBLISH_OUTCOME_UNKNOWN",
        "A previous attempt already invoked Facebook's feed-post creation and its outcome could not be confirmed; refusing to retry to avoid a duplicate post. Manual verification is required.",
      );
    }
    await callbacks?.saveCheckpoint({ phase: "SOCIAL_POST_ATTEMPTED" } satisfies FacebookSocialPostCheckpoint);

    const { status, json } = await this.client.graphRequest("POST", `/${credential.pageId}/feed`, credential.accessToken, { message: caption ?? "" });
    if (status < 200 || status >= 300 || !isRecord(json) || typeof json.id !== "string") {
      throw classifyMetaGraphFailure(status, json, "feed post create");
    }
    // No externalUrl — Meta's own feed-post response documents no stable
    // permalink field, same "never fabricated" discipline as the video
    // path's own createPageVideoPost.
    return { externalContentId: json.id };
  }


  private async createUploadSession(credential: MetaCredentialPayload, fileLength: number, contentType?: string): Promise<string> {
    const { status, json } = await this.client.graphRequest("POST", `/${this.appId}/uploads`, credential.accessToken, {
      file_name: "video.mp4",
      file_length: fileLength,
      file_type: contentType ?? "video/mp4",
    });
    if (status < 200 || status >= 300 || !isRecord(json) || typeof json.id !== "string") {
      throw classifyMetaGraphFailure(status, json, "upload session create");
    }
    // Response id is "upload:<SESSION_ID>" — the session id alone is what
    // this connector persists/reuses; the "upload:" prefix is re-added at
    // every call site that needs the full resource path.
    return json.id.startsWith("upload:") ? json.id.slice("upload:".length) : json.id;
  }

  private async transferBytes(credential: MetaCredentialPayload, uploadSessionId: string, totalBytes: number, mediaAssetPublicId: string, mediaReader: NonNullable<PublishingExecutionCallbacks["mediaReader"]>): Promise<string> {
    let offset = 0;
    let fileHandle: string | undefined;
    while (offset < totalBytes) {
      const end = Math.min(offset + this.chunkSizeBytes, totalBytes) - 1;
      const chunk = await mediaReader.readRange(mediaAssetPublicId, offset, end);
      const { status, json } = await this.client.uploadRequest(`/upload:${uploadSessionId}`, credential.accessToken, chunk, { file_offset: String(offset) });
      if (status < 200 || status >= 300 || !isRecord(json)) {
        throw classifyMetaGraphFailure(status, json, "upload chunk transfer");
      }
      if (typeof json.h === "string") fileHandle = json.h;
      offset = end + 1;
    }
    if (!fileHandle) {
      throw new PublishingProviderPermanentError("FACEBOOK_MALFORMED_RESPONSE", "Facebook's resumable upload completed without returning a file handle.");
    }
    return fileHandle;
  }

  private async createPageVideoPost(credential: MetaCredentialPayload, fileHandle: string, caption?: string): Promise<PublishingPublishResult> {
    const { status, json } = await this.client.graphRequest("POST", `/${credential.pageId}/videos`, credential.accessToken, {
      fbuploader_video_file_chunk: fileHandle,
      ...(caption ? { description: caption } : {}),
    });
    if (status < 200 || status >= 300 || !isRecord(json) || typeof json.id !== "string") {
      throw classifyMetaGraphFailure(status, json, "page video post create");
    }
    // No externalUrl (Part Z research finding): the Video Graph object has
    // no documented `permalink_url`/stable-link field, and no officially
    // documented URL template exists (unlike YouTube's fixed
    // watch?v= pattern) — never fabricated.
    return { externalContentId: json.id };
  }

  private parseCredential(raw: Record<string, unknown>): MetaCredentialPayload | null {
    return parseMetaCredential(raw);
  }

  private classifyConnectionFailure(status: number, json: unknown): PublishingConnectionValidationResult {
    const failure = classifyMetaGraphFailure(status, json, "connection check");
    if (failure instanceof PublishingProviderRetryableError) return { healthy: false, reasonCode: "PROVIDER_UNAVAILABLE", detail: "Meta Graph API is temporarily unavailable." };
    if (failure.errorCode === "META_UNAUTHORIZED") return { healthy: false, reasonCode: "CREDENTIAL_REVOKED", detail: "Facebook rejected the stored credential (unauthorized)." };
    if (failure.errorCode === "META_INSUFFICIENT_PERMISSION") return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "The granted Facebook permissions are insufficient." };
    return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "Facebook rejected the credential." };
  }
}
