import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AiJobsModule } from "../ai-jobs/ai-jobs.module";
import { ContentModule } from "../content/content.module";
import { TopicClustersController } from "./topic-clusters.controller";
import { TopicClustersService } from "./topic-clusters.service";

// Module 5 Phase 5.1 — Content Planner: Topic Cluster Planning. Reuses
// Module 3's generic AiJob read primitive (AiJobSubmissionService, via
// AiJobsModule) to resolve a completed Research run, and Module 1E's
// ContentSeriesService (via ContentModule) to validate an optional
// content-series attachment — never a second AI runtime, never a
// duplicate content-series implementation.
@Module({
  imports: [AuthModule, AiJobsModule, ContentModule],
  controllers: [TopicClustersController],
  providers: [TopicClustersService],
})
export class TopicClustersModule {}
