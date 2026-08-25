import { IsInt, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, Min } from "class-validator";

export class CreateAiJobDto {
  @IsString()
  @IsNotEmpty()
  agentIdentifier!: string;

  // Omitted resolves the highest registered version deterministically
  // (see AgentRegistry.resolve) — the created ai_jobs row always records
  // exactly which version was actually used.
  @IsOptional()
  @IsInt()
  @Min(1)
  agentVersion?: number;

  // The EXACT Knowledge Pack version's public id — never "the
  // workspace's active pack", resolved implicitly (Module 2's own
  // non-substitution principle, reused verbatim here).
  @IsUUID()
  knowledgePackVersionId!: string;

  @IsObject()
  input!: Record<string, unknown>;
}
