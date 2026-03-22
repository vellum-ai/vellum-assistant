/**
 * Migration rollback endpoint — rolls back DB and/or workspace migrations
 * to a specified target version/migration ID.
 *
 * Protected by a route policy restricting access to gateway service
 * principals only (`svc_gateway` with `internal.write` scope), following
 * the same pattern as other gateway-forwarded control-plane endpoints.
 */

import { getDb } from "../../memory/db-connection.js";
import { rollbackMemoryMigration } from "../../memory/migrations/validate-migration-state.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { WORKSPACE_MIGRATIONS } from "../../workspace/migrations/registry.js";
import {
  loadCheckpoints,
  rollbackWorkspaceMigrations,
} from "../../workspace/migrations/runner.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

export function migrationRollbackRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "admin/rollback-migrations",
      method: "POST",
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

        const { targetDbVersion, targetWorkspaceMigrationId } = body as {
          targetDbVersion?: unknown;
          targetWorkspaceMigrationId?: unknown;
        };

        // At least one rollback target must be specified.
        if (
          targetDbVersion === undefined &&
          targetWorkspaceMigrationId === undefined
        ) {
          return httpError(
            "BAD_REQUEST",
            "At least one of targetDbVersion or targetWorkspaceMigrationId must be provided",
            400,
          );
        }

        // Validate targetDbVersion when provided.
        if (targetDbVersion !== undefined) {
          if (
            typeof targetDbVersion !== "number" ||
            !Number.isInteger(targetDbVersion) ||
            targetDbVersion < 0
          ) {
            return httpError(
              "BAD_REQUEST",
              "targetDbVersion must be a non-negative integer",
              400,
            );
          }
        }

        // Validate targetWorkspaceMigrationId when provided.
        if (targetWorkspaceMigrationId !== undefined) {
          if (
            typeof targetWorkspaceMigrationId !== "string" ||
            targetWorkspaceMigrationId.length === 0
          ) {
            return httpError(
              "BAD_REQUEST",
              "targetWorkspaceMigrationId must be a non-empty string",
              400,
            );
          }
        }

        // Preflight: validate that the workspace migration ID exists in the
        // registry BEFORE executing any mutations. This prevents the DB
        // rollback from committing when the workspace target is invalid.
        let resolvedTargetIndex = -1;
        if (targetWorkspaceMigrationId !== undefined) {
          const targetId = targetWorkspaceMigrationId as string;
          resolvedTargetIndex = WORKSPACE_MIGRATIONS.findIndex(
            (m) => m.id === targetId,
          );
          if (resolvedTargetIndex === -1) {
            return httpError(
              "BAD_REQUEST",
              `Target workspace migration "${targetId}" not found in the registry`,
              400,
            );
          }
        }

        const rolledBack: { db: string[]; workspace: string[] } = {
          db: [],
          workspace: [],
        };

        // Roll back DB migrations if requested.
        if (targetDbVersion !== undefined) {
          try {
            rolledBack.db = rollbackMemoryMigration(
              getDb(),
              targetDbVersion as number,
            );
          } catch (err) {
            const detail = err instanceof Error ? err.message : "Unknown error";
            return httpError(
              "INTERNAL_ERROR",
              `DB migration rollback failed: ${detail}`,
              500,
            );
          }
        }

        // Roll back workspace migrations if requested.
        if (targetWorkspaceMigrationId !== undefined) {
          const workspaceDir = getWorkspaceDir();

          // Compute which migrations are candidates for rollback before
          // executing, since rollbackWorkspaceMigrations returns void.
          const targetId = targetWorkspaceMigrationId as string;

          const checkpointsBefore = loadCheckpoints(workspaceDir);
          const candidateIds = WORKSPACE_MIGRATIONS.slice(
            resolvedTargetIndex + 1,
          )
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
            // Re-read checkpoints to determine which migrations were actually
            // rolled back before the error occurred. A candidate whose entry
            // is no longer present in the checkpoint file was successfully
            // reverted.
            const checkpointsAfter = loadCheckpoints(workspaceDir);
            const actuallyRolledBack = candidateIds.filter(
              (id) => !checkpointsAfter.applied[id],
            );

            const detail = err instanceof Error ? err.message : "Unknown error";
            return httpError(
              "INTERNAL_ERROR",
              `Workspace migration rollback failed: ${detail}`,
              500,
              {
                partialRolledBack: {
                  db: rolledBack.db,
                  workspace: actuallyRolledBack,
                },
              },
            );
          }
        }

        return Response.json({ ok: true, rolledBack });
      },
    },
  ];
}
