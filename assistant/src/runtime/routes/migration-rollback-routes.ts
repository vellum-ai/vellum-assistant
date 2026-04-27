/**
 * Migration rollback endpoint — rolls back DB and/or workspace migrations
 * to a specified target version/migration ID.
 *
 * Protected by a route policy restricting access to gateway service
 * principals only (`svc_gateway` with `internal.write` scope), following
 * the same pattern as other gateway-forwarded control-plane endpoints.
 */

import { z } from "zod";

import { getDb } from "../../memory/db-connection.js";
import { getMaxMigrationVersion } from "../../memory/migrations/registry.js";
import { rollbackMemoryMigration } from "../../memory/migrations/validate-migration-state.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { WORKSPACE_MIGRATIONS } from "../../workspace/migrations/registry.js";
import {
  getLastWorkspaceMigrationId,
  loadCheckpoints,
  rollbackWorkspaceMigrations,
} from "../../workspace/migrations/runner.js";
import { BadRequestError, InternalError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

async function handleRollbackMigrations({ body = {} }: RouteHandlerArgs) {
  const {
    targetDbVersion,
    targetWorkspaceMigrationId,
    rollbackToRegistryCeiling,
  } = body as {
    targetDbVersion?: unknown;
    targetWorkspaceMigrationId?: unknown;
    rollbackToRegistryCeiling?: unknown;
  };

  // When rollbackToRegistryCeiling is true, auto-determine targets
  // from this daemon's own migration registry ceilings.
  let effectiveDbVersion = targetDbVersion as number | undefined;
  let effectiveWorkspaceMigrationId = targetWorkspaceMigrationId as
    | string
    | undefined;

  if (rollbackToRegistryCeiling === true) {
    if (effectiveDbVersion === undefined)
      effectiveDbVersion = getMaxMigrationVersion();
    if (effectiveWorkspaceMigrationId === undefined)
      effectiveWorkspaceMigrationId =
        getLastWorkspaceMigrationId(WORKSPACE_MIGRATIONS) ?? undefined;
  }

  if (
    effectiveDbVersion === undefined &&
    effectiveWorkspaceMigrationId === undefined
  ) {
    throw new BadRequestError(
      "At least one of targetDbVersion or targetWorkspaceMigrationId must be provided",
    );
  }

  if (effectiveDbVersion !== undefined) {
    if (
      typeof effectiveDbVersion !== "number" ||
      !Number.isInteger(effectiveDbVersion) ||
      effectiveDbVersion < 0
    ) {
      throw new BadRequestError(
        "targetDbVersion must be a non-negative integer",
      );
    }
  }

  if (effectiveWorkspaceMigrationId !== undefined) {
    if (
      typeof effectiveWorkspaceMigrationId !== "string" ||
      effectiveWorkspaceMigrationId.length === 0
    ) {
      throw new BadRequestError(
        "targetWorkspaceMigrationId must be a non-empty string",
      );
    }
  }

  // Preflight: validate that the workspace migration ID exists in the
  // registry BEFORE executing any mutations.
  let resolvedTargetIndex = -1;
  if (effectiveWorkspaceMigrationId !== undefined) {
    const targetId = effectiveWorkspaceMigrationId as string;
    resolvedTargetIndex = WORKSPACE_MIGRATIONS.findIndex(
      (m) => m.id === targetId,
    );
    if (resolvedTargetIndex === -1) {
      throw new BadRequestError(
        `Target workspace migration "${targetId}" not found in the registry`,
      );
    }
  }

  const rolledBack: { db: string[]; workspace: string[] } = {
    db: [],
    workspace: [],
  };

  // Roll back DB migrations if requested.
  if (effectiveDbVersion !== undefined) {
    try {
      rolledBack.db = rollbackMemoryMigration(getDb(), effectiveDbVersion);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Unknown error";
      throw new InternalError(`DB migration rollback failed: ${detail}`);
    }
  }

  // Roll back workspace migrations if requested.
  if (effectiveWorkspaceMigrationId !== undefined) {
    const workspaceDir = getWorkspaceDir();
    const targetId = effectiveWorkspaceMigrationId;

    const checkpointsBefore = loadCheckpoints(workspaceDir);
    const candidateIds = WORKSPACE_MIGRATIONS.slice(resolvedTargetIndex + 1)
      .filter((m) => {
        const entry = checkpointsBefore.applied[m.id];
        return (
          entry &&
          entry.status !== "started" &&
          entry.status !== "rolling_back"
        );
      })
      .map((m) => m.id);

    try {
      await rollbackWorkspaceMigrations(
        workspaceDir,
        WORKSPACE_MIGRATIONS,
        targetId,
      );

      rolledBack.workspace = candidateIds;
    } catch (err) {
      const checkpointsAfter = loadCheckpoints(workspaceDir);
      const _actuallyRolledBack = candidateIds.filter(
        (id) => !checkpointsAfter.applied[id],
      );

      const detail = err instanceof Error ? err.message : "Unknown error";
      throw new InternalError(
        `Workspace migration rollback failed (partial: db=${JSON.stringify(rolledBack.db)}, workspace=${JSON.stringify(_actuallyRolledBack)}): ${detail}`,
      );
    }
  }

  return { ok: true, rolledBack };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "admin_rollbackmigrations_post",
    endpoint: "admin/rollback-migrations",
    method: "POST",
    summary: "Rollback migrations",
    description:
      "Roll back DB and/or workspace migrations to a specified target version. Restricted to gateway service principals.",
    tags: ["admin"],
    requirePolicyEnforcement: true,
    handler: handleRollbackMigrations,
    requestBody: z.object({
      targetDbVersion: z
        .number()
        .int()
        .describe("Target DB migration version"),
      targetWorkspaceMigrationId: z
        .string()
        .describe("Target workspace migration ID"),
      rollbackToRegistryCeiling: z
        .boolean()
        .describe("Auto-determine targets from daemon registry ceilings"),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      rolledBack: z
        .object({})
        .passthrough()
        .describe("Lists of rolled-back DB and workspace migrations"),
    }),
  },
];
