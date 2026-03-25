/**
 * Migration rollback endpoint — rolls back DB and/or workspace migrations
 * to a specified target version/migration ID.
 *
 * Protected by a route policy restricting access to gateway service
 * principals only (`svc_gateway` with `internal.write` scope), following
 * the same pattern as other gateway-forwarded control-plane endpoints.
 */

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
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

export function migrationRollbackRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "admin/rollback-migrations",
      method: "POST",
      summary: "Rollback migrations",
      description:
        "Roll back DB and/or workspace migrations to a specified target version. Restricted to gateway service principals.",
      tags: ["admin"],
      requestBody: {
        type: "object",
        properties: {
          targetDbVersion: {
            type: "integer",
            description: "Target DB migration version",
          },
          targetWorkspaceMigrationId: {
            type: "string",
            description: "Target workspace migration ID",
          },
          rollbackToRegistryCeiling: {
            type: "boolean",
            description: "Auto-determine targets from daemon registry ceilings",
          },
        },
      },
      responseBody: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          rolledBack: {
            type: "object",
            description: "Lists of rolled-back DB and workspace migrations",
          },
        },
      },
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

        // At least one rollback target must be specified.
        if (
          effectiveDbVersion === undefined &&
          effectiveWorkspaceMigrationId === undefined
        ) {
          return httpError(
            "BAD_REQUEST",
            "At least one of targetDbVersion or targetWorkspaceMigrationId must be provided",
            400,
          );
        }

        // Validate effectiveDbVersion when provided.
        if (effectiveDbVersion !== undefined) {
          if (
            typeof effectiveDbVersion !== "number" ||
            !Number.isInteger(effectiveDbVersion) ||
            effectiveDbVersion < 0
          ) {
            return httpError(
              "BAD_REQUEST",
              "targetDbVersion must be a non-negative integer",
              400,
            );
          }
        }

        // Validate effectiveWorkspaceMigrationId when provided.
        if (effectiveWorkspaceMigrationId !== undefined) {
          if (
            typeof effectiveWorkspaceMigrationId !== "string" ||
            effectiveWorkspaceMigrationId.length === 0
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
        if (effectiveWorkspaceMigrationId !== undefined) {
          const targetId = effectiveWorkspaceMigrationId as string;
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
        if (effectiveDbVersion !== undefined) {
          try {
            rolledBack.db = rollbackMemoryMigration(
              getDb(),
              effectiveDbVersion,
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
        if (effectiveWorkspaceMigrationId !== undefined) {
          const workspaceDir = getWorkspaceDir();

          // Compute which migrations are candidates for rollback before
          // executing, since rollbackWorkspaceMigrations returns void.
          const targetId = effectiveWorkspaceMigrationId;

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
