export type DependencyStatus = "up" | "down";

export interface LivenessResponse {
  status: "ok";
  timestamp: string;
}

export interface ReadinessResponse {
  status: "ok" | "degraded";
  dependencies: {
    database: DependencyStatus;
    redis: DependencyStatus;
    storage: DependencyStatus;
  };
  timestamp: string;
}
