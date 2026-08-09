import { randomUUID } from "crypto";
import { hostname } from "os";
import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { PrismaService } from "../prisma/prisma.service";
import type { WorkerConfig } from "../config/configuration";

/**
 * Process-level visibility layer — separate from, and never a trigger
 * for, BullMQ's own job-level stalled-job detection (lock+renewal,
 * already handled natively by BullMQ). This table exists for dashboards,
 * crash alerting, and version-rollout tracking only; nothing reads it to
 * decide whether to redispatch a job.
 */
@Injectable()
export class WorkerHeartbeatService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly workerId = randomUUID();
  private readonly startedAt = new Date();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<WorkerConfig, true>,
    @InjectPinoLogger(WorkerHeartbeatService.name) private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    process.stderr.write(`[LIFECYCLE] WorkerHeartbeatService.onApplicationBootstrap START t=${Date.now()}\n`);
    await this.beat();
    process.stderr.write(`[LIFECYCLE] WorkerHeartbeatService.onApplicationBootstrap END t=${Date.now()}\n`);
    const intervalMs = this.config.get("heartbeatIntervalMs", { infer: true });
    this.timer = setInterval(() => {
      this.beat().catch((error: unknown) => {
        this.logger.warn({ err: error, workerId: this.workerId }, "heartbeat upsert failed");
      });
    }, intervalMs);
    this.timer.unref();
  }

  private async beat(): Promise<void> {
    process.stderr.write(`[LIFECYCLE] WorkerHeartbeatService.beat() upsert START t=${Date.now()}\n`);
    const now = new Date();
    await this.prisma.workerHeartbeat.upsert({
      where: { workerId: this.workerId },
      create: {
        workerId: this.workerId,
        hostname: hostname(),
        processId: process.pid,
        applicationVersion: this.config.get("applicationVersion", { infer: true }),
        queueAssignments: this.config.get("queues", { infer: true }),
        startedAt: this.startedAt,
        lastHeartbeatAt: now,
      },
      update: {
        lastHeartbeatAt: now,
      },
    });
    process.stderr.write(`[LIFECYCLE] WorkerHeartbeatService.beat() upsert END t=${Date.now()}\n`);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
