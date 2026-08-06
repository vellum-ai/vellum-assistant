/**
 * Workspace git admin endpoints — commit pending workspace changes, and
 * compact workspace git history on demand.
 */

import { z } from "zod";

import { getWorkspaceDir } from "../../util/platform.js";
import { getWorkspaceGitService } from "../../workspace/git-service.js";
import { GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import { parseBody } from "./parse-body.js";
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

const compactHistoryBodySchema = z.object({
  force: z
    .boolean()
    .optional()
    .describe("Squash aged history even when no oversized blob is reclaimable"),
  retentionDays: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Retention window override in days (default 7)"),
});

async function handleWorkspaceCompactHistory({ body }: RouteHandlerArgs) {
  const { force, retentionDays } = parseBody(
    compactHistoryBodySchema,
    body ?? {},
  );
  return getWorkspaceGitService(getWorkspaceDir()).compactHistoryNow({
    force,
    retentionDays,
  });
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "workspace_commit",
    endpoint: "admin/workspace-commit",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
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
  {
    operationId: "workspace_compact_history",
    endpoint: "admin/workspace-compact-history",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Compact workspace git history",
    description:
      "Squash workspace git history older than the retention window into a single base commit and prune reclaimed objects. " +
      "By default acts only when an oversized blob is reclaimable; with force, the squash runs unconditionally.",
    tags: ["admin"],
    requestBody: compactHistoryBodySchema,
    responseBody: z.object({
      rewrote: z.boolean(),
      squashedCommits: z.number(),
      keptCommits: z.number(),
      retryAfterMs: z.number().optional(),
    }),
    handler: handleWorkspaceCompactHistory,
  },
];
