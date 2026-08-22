import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { KnowledgePacksController } from "./knowledge-packs.controller";
import { KnowledgePacksService } from "./knowledge-packs.service";

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [KnowledgePacksController],
  providers: [KnowledgePacksService],
})
export class KnowledgePacksModule {}
