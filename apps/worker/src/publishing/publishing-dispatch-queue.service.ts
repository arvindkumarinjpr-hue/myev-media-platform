import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import Redis from "ioredis";
import type { WorkerConfig } from "../config/configuration";

/**
 * Module 9 Phase 9.3 — a minimal, dedicated BullMQ Queue accessor for the
 * PUBLISHING queue, used exclusively by PublishingDispatchService to
 * enqueue a NEW `publishing.execute.v1` job from within a running
 * `publishing.dispatch.v1` job handler.
 *
 * Deliberately narrow — not a general-purpose enqueue service. That
 * broader pattern already exists twice (apps/api's own
 * BackgroundJobsService.enqueue(), apps/worker's own
 * SchedulerTickManager.dispatchOccurrence()) and neither is reusable
 * here without crossing the API/worker process boundary or reaching
 * into scheduler-internal private methods — both out of this phase's
 * scope. A known, documented simplification: this connection closes on
 * module destroy but is not registered with the shared bounded-shutdown
 * tracker the way SchedulerTickManager's own connection is (Part K/T
 * technical debt) — acceptable because the PUBLISHING queue carries no
 * long-running in-flight dispatch state to preserve across a shutdown
 * signal; a future hardening pass should fold this into the same
 * tracker if the risk profile changes.
 */
@Injectable()
export class PublishingDispatchQueueService implements OnApplicationShutdown {
  private queue?: Queue;
  private connection?: Redis;

  constructor(private readonly config: ConfigService<WorkerConfig, true>) {}

  private getQueue(): Queue {
    if (!this.queue) {
      this.connection = new Redis(this.config.get("redisUrl", { infer: true }), { maxRetriesPerRequest: null });
      this.queue = new Queue("PUBLISHING", { connection: this.connection });
    }
    return this.queue;
  }

  async add(jobType: string, jobId: string, payload: object): Promise<void> {
    await this.getQueue().add(jobType, payload, { jobId, attempts: 1, removeOnComplete: { age: 3_600 }, removeOnFail: { age: 86_400 } });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue?.close();
    await this.connection?.quit().catch(() => undefined);
  }
}
