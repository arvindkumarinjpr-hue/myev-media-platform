import { Global, Module } from "@nestjs/common";
import { PERMISSION_RESOLVER } from "./permission-resolver.interface";
import { NoAssignmentPermissionResolver } from "./no-assignment-permission-resolver";
import { PermissionGuard } from "../../common/guards/permission.guard";

@Global()
@Module({
  providers: [{ provide: PERMISSION_RESOLVER, useClass: NoAssignmentPermissionResolver }, PermissionGuard],
  exports: [PERMISSION_RESOLVER, PermissionGuard],
})
export class RbacModule {}
