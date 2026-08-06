import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { MalwareScanModule } from "../malware-scan/malware-scan.module";
import { MediaAssetsController } from "./media-assets.controller";
import { MediaAssetsService } from "./media-assets.service";

@Module({
  imports: [AuthModule, StorageModule, MalwareScanModule],
  controllers: [MediaAssetsController],
  providers: [MediaAssetsService],
})
export class MediaAssetsModule {}
