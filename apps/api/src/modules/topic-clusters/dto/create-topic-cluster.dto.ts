import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

// Module 5 Phase 5.1 (FR-PLAN-002) — promotes one entry from a completed
// Research run's own keywordClusters[] into a real, planning-level
// Topic Cluster. researchId + keywordClusterTopic together identify
// exactly which cluster; nothing here lets the caller invent keyword/
// cluster content — that is always resolved server-side from the
// Research run's own persisted output.
export class CreateTopicClusterDto {
  @IsUUID()
  researchId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  keywordClusterTopic!: string;

  // Defaults to the keyword cluster's own topic when omitted — a
  // distinct planning-level name is optional, not required by FR-PLAN-002.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsUUID()
  contentSeriesId?: string;
}
