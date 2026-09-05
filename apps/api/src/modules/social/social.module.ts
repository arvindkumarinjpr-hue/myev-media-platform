import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AiAgentsModule } from "../ai-agents/ai-agents.module";
import { ContentModule } from "../content/content.module";
import { SocialController } from "./social.controller";
import { SocialGenerationService } from "./social-generation.service";
import { SocialService } from "./social.service";

/**
 * Module 10 Phase 10.2 — Social Media Generation.
 *
 * Composes existing modules only:
 *  - AuthModule    → SessionGuard's JwtService (PermissionGuard/RbacModule are @Global).
 *  - AiAgentsModule → AgentExecutorService, the synchronous internal execution
 *    primitive (no durable queue, no new processor — see social-generation.service.ts's own doc comment).
 *  - ContentModule → ContentPermissionResolver + ContentBodyValidator, reused unchanged.
 */
@Module({
  imports: [AuthModule, AiAgentsModule, ContentModule],
  controllers: [SocialController],
  providers: [SocialGenerationService, SocialService],
  exports: [SocialGenerationService, SocialService],
})
export class SocialModule {}
