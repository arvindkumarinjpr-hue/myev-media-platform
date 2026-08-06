import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { ProcessorContext, ProcessorHandler, SystemPingPayload, SystemPingResult } from "@myev/shared";

@Injectable()
export class SystemPingProcessor {
  constructor(@InjectPinoLogger(SystemPingProcessor.name) private readonly logger: PinoLogger) {}

  readonly handle: ProcessorHandler<SystemPingPayload, SystemPingResult> = async (
    payload: SystemPingPayload,
    context: ProcessorContext,
  ): Promise<SystemPingResult> => {
    this.logger.info({ jobId: context.jobId, correlationId: context.correlationId, attempt: context.attempt }, "system.ping.v1 processed");
    return { echo: payload.echo ?? "pong", respondedAt: new Date().toISOString() };
  };
}
