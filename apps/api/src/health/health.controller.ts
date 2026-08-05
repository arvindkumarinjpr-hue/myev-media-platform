import { Controller, Get, HttpCode, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";
import type { LivenessResponse } from "@myev/shared";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  // Liveness: process is up. No auth, no dependency checks — per API Spec §25.
  @Get()
  @HttpCode(HttpStatus.OK)
  liveness(): LivenessResponse {
    return { status: "ok", timestamp: new Date().toISOString() };
  }

  // Readiness: dependencies are reachable — per API Spec §25.
  // Returns 200 when fully healthy, 503 when degraded, so orchestration
  // tooling (Docker healthcheck, future load balancers) can act on it.
  @Get("ready")
  async readiness(@Res() res: Response): Promise<void> {
    const result = await this.healthService.checkReadiness();
    const statusCode = result.status === "ok" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;
    res.status(statusCode).json(result);
  }
}
