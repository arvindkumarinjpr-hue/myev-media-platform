import { Global, Module } from "@nestjs/common";
import {
  AI_EXECUTE_V1_MANIFEST,
  MEDIA_IMAGE_GENERATE_V1_MANIFEST,
  MEDIA_SUBTITLE_GENERATE_V1_MANIFEST,
  MEDIA_TTS_V1_MANIFEST,
  QueueRegistryBuilder,
  SYSTEM_PING_V1_MANIFEST,
  type QueueRegistry,
} from "@myev/shared";

export const QUEUE_REGISTRY = Symbol("QUEUE_REGISTRY");

/**
 * The API process's own QueueRegistry — manifest-only, no handlers bound
 * (this process never executes a job, only enqueues/inspects/cancels/
 * retries one). freeze() is called with no `requireHandlersForQueues`,
 * since the bijective handler<->manifest check is scoped to Worker
 * processes only (see @myev/shared's QueueRegistryBuilder). Every job
 * type this process can enqueue or act on must be registered here —
 * kept in lockstep with apps/worker's own registry by both reading from
 * the same @myev/shared manifest constants.
 */
@Global()
@Module({
  providers: [
    {
      provide: QUEUE_REGISTRY,
      useFactory: (): QueueRegistry => {
        const builder = new QueueRegistryBuilder();
        builder.registerManifest(SYSTEM_PING_V1_MANIFEST);
        // Module 3 Phase 3.3 — manifest-only here too (this process never
        // executes a job, only enqueues one — see this module's own doc
        // comment above).
        builder.registerManifest(AI_EXECUTE_V1_MANIFEST);
        // Module 7 Phase 7.4 — manifest-only here (this process enqueues
        // media.* jobs; the worker binds their handlers).
        builder.registerManifest(MEDIA_IMAGE_GENERATE_V1_MANIFEST);
        builder.registerManifest(MEDIA_TTS_V1_MANIFEST);
        builder.registerManifest(MEDIA_SUBTITLE_GENERATE_V1_MANIFEST);
        return builder.freeze();
      },
    },
  ],
  exports: [QUEUE_REGISTRY],
})
export class QueueRegistryModule {}
