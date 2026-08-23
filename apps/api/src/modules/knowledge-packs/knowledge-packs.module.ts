import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { KnowledgePacksController } from "./knowledge-packs.controller";
import { KnowledgePacksService } from "./knowledge-packs.service";

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [KnowledgePacksController],
  providers: [KnowledgePacksService],
  // Module 3 Phase 3.2: AiAgentsModule reuses findOne() for exact
  // Knowledge Pack version resolution rather than duplicating its
  // workspace-scoping/not-found logic.
  exports: [KnowledgePacksService],
})
export class KnowledgePacksModule {}
