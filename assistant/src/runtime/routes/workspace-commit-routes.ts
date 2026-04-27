/**
 * Workspace commit endpoint — creates a git commit in the workspace
 * directory with all pending changes.
 */

import { z } from "zod";

import { getWorkspaceDir } from "../../util/platform.js";
import { getWorkspaceGitService } from "../../workspace/git-service.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

async function handleWorkspaceCommit({ body }: RouteHandlerArgs) {
  const message = body?.message;

  if (typeof message !== "string" || message.length === 0) {
    throw new BadRequestError(
      "message is required and must be a non-empty string",
    );
  }

  await getWorkspaceGitService(getWorkspaceDir()).commitChanges(message);
  return { ok: true };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "workspace_commit",
    endpoint: "admin/workspace-commit",
    method: "POST",
    summary: "Commit workspace changes",
    description:
      "Create a git commit in the workspace directory with all pending changes.",
    tags: ["admin"],
    requestBody: z.object({
      message: z.string().describe("Commit message"),
    }),
    responseBody: z.object({
      ok: z.boolean(),
    }),
    handler: handleWorkspaceCommit,
  },
];
