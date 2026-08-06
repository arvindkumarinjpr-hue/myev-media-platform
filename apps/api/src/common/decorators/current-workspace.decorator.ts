import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { WorkspaceContext, WorkspaceScopedRequest } from "../guards/workspace-context.guard";

/** Mirrors @CurrentUser() — requires WorkspaceContextGuard to have run first. */
export const CurrentWorkspace = createParamDecorator((_data: unknown, ctx: ExecutionContext): WorkspaceContext => {
  const request = ctx.switchToHttp().getRequest<WorkspaceScopedRequest>();
  return request.workspace;
});
