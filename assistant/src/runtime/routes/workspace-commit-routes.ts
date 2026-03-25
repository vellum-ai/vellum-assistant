/**
 * Workspace commit endpoint — creates a git commit in the workspace
 * directory with all pending changes.
 *
 * Protected by a route policy restricting access to gateway service
 * principals only (`svc_gateway` with `internal.write` scope), following
 * the same pattern as other gateway-forwarded control-plane endpoints.
 */

import { z } from "zod";

import { getWorkspaceDir } from "../../util/platform.js";
import { getWorkspaceGitService } from "../../workspace/git-service.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

export function workspaceCommitRouteDefinitions(): RouteDefinition[] {
  return [
    {
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
      handler: async ({ req }) => {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return httpError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        if (!body || typeof body !== "object") {
          return httpError(
            "BAD_REQUEST",
            "Request body must be a JSON object",
            400,
          );
        }

        const { message } = body as { message?: unknown };

        if (typeof message !== "string" || message.length === 0) {
          return httpError(
            "BAD_REQUEST",
            "message is required and must be a non-empty string",
            400,
          );
        }

        try {
          await getWorkspaceGitService(getWorkspaceDir()).commitChanges(
            message,
          );
          return Response.json({ ok: true });
        } catch (err) {
          const detail = err instanceof Error ? err.message : "Unknown error";
          return httpError(
            "INTERNAL_ERROR",
            `Workspace commit failed: ${detail}`,
            500,
          );
        }
      },
    },
  ];
}
