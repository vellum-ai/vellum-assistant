/**
 * Route handlers for migration endpoints.
 *
 * POST /v1/migrations/validate        — validate a .vbundle archive upload.
 * POST /v1/migrations/export          — generate and download a .vbundle archive.
 * POST /v1/migrations/import-preflight — dry-run import analysis of a .vbundle archive.
 * POST /v1/migrations/import          — commit a .vbundle archive import to disk.
 *
 * Accepts raw binary body (Content-Type: application/octet-stream) or
 * multipart form data with a "file" field. Returns structured validation
 * results with is_valid flag and detailed error descriptions.
 */

import { join } from "node:path";
import { Database } from "bun:sqlite";

import { invalidateConfigCache } from "../../config/loader.js";
import { resetDb } from "../../memory/db-connection.js";
import { getLogger } from "../../util/logger.js";
import {
  getDbPath,
  getRootDir,
  getWorkspaceConfigPath,
  getWorkspaceSkillsDir,
} from "../../util/platform.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import { buildExportVBundle } from "../migrations/vbundle-builder.js";
import {
  analyzeImport,
  DefaultPathResolver,
} from "../migrations/vbundle-import-analyzer.js";
import { commitImport } from "../migrations/vbundle-importer.js";
import { validateVBundle } from "../migrations/vbundle-validator.js";

const log = getLogger("migration-routes");

/**
 * POST /v1/migrations/validate
 *
 * Validates a .vbundle archive. The file can be sent as:
 * - Raw binary body with Content-Type: application/octet-stream
 * - Multipart form data with a "file" field
 *
 * Returns:
 *   200: { is_valid: true, manifest: { ... } }
 *   200: { is_valid: false, errors: [{ code, message, path? }] }
 *   400: Standard error envelope for missing/empty body
 *   422: Standard error envelope for completely unparseable input
 */
export async function handleMigrationValidate(req: Request): Promise<Response> {
  let fileData: Uint8Array | null = null;

  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    try {
      const formData = await req.formData();
      const file = formData.get("file");
      if (!file || !(file instanceof Blob)) {
        return httpError(
          "BAD_REQUEST",
          'Multipart upload requires a "file" field',
          400,
        );
      }
      fileData = new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      log.error({ err }, "Failed to parse multipart form data");
      return httpError("BAD_REQUEST", "Invalid multipart form data", 400);
    }
  } else {
    // Treat as raw binary body
    try {
      const arrayBuffer = await req.arrayBuffer();
      fileData = new Uint8Array(arrayBuffer);
    } catch (err) {
      log.error({ err }, "Failed to read request body");
      return httpError("BAD_REQUEST", "Failed to read request body", 400);
    }
  }

  if (!fileData || fileData.length === 0) {
    return httpError(
      "BAD_REQUEST",
      "Request body is empty — a .vbundle file is required",
      400,
    );
  }

  try {
    const result = validateVBundle(fileData);

    return Response.json({
      is_valid: result.is_valid,
      errors: result.errors,
      ...(result.manifest ? { manifest: result.manifest } : {}),
    });
  } catch (err) {
    log.error({ err }, "Unexpected error during vbundle validation");
    return httpError(
      "INTERNAL_ERROR",
      err instanceof Error ? err.message : "Unexpected validation error",
      500,
    );
  }
}

/**
 * POST /v1/migrations/export
 *
 * Exports the assistant's real data as a .vbundle archive. The archive
 * contains the SQLite database (all conversations, messages, memory
 * segments, embeddings) and the config file.
 *
 * Accepts an optional JSON body:
 *   { "description": "Human-readable export description" }
 *
 * Returns:
 *   200: Binary .vbundle archive (Content-Type: application/octet-stream)
 *        with Content-Disposition header for download.
 *   500: Standard error envelope for unexpected failures.
 *
 * Auth: Requires settings.write scope. Allowed for actor, svc_gateway, svc_daemon, local.
 */
export async function handleMigrationExport(req: Request): Promise<Response> {
  let description: string | undefined;

  // Parse optional JSON body for export metadata
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      if (typeof body.description === "string") {
        description = body.description;
      }
    } catch (err) {
      log.warn({ err }, "Failed to parse export request body — using defaults");
    }
  }

  try {
    const { archive, manifest } = buildExportVBundle({
      dbPath: getDbPath(),
      configPath: getWorkspaceConfigPath(),
      trustPath: join(getRootDir(), "protected", "trust.json"),
      skillsDir: getWorkspaceSkillsDir(),
      source: "runtime-export",
      description,
      checkpoint: () => {
        try {
          const dbPath = getDbPath();
          const db = new Database(dbPath);
          try {
            db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          } finally {
            db.close();
          }
        } catch (err) {
          log.warn(
            { err },
            "WAL checkpoint failed — exporting without checkpoint",
          );
        }
      },
    });

    const timestamp = manifest.created_at.replace(/[:.]/g, "-");
    const filename = `export-${timestamp}.vbundle`;

    const body = archive.buffer.slice(
      archive.byteOffset,
      archive.byteOffset + archive.byteLength,
    ) as ArrayBuffer;

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(archive.length),
        "X-Vbundle-Schema-Version": manifest.schema_version,
        "X-Vbundle-Manifest-Sha256": manifest.manifest_sha256,
      },
    });
  } catch (err) {
    log.error({ err }, "Failed to build export bundle");
    return httpError(
      "INTERNAL_ERROR",
      err instanceof Error ? err.message : "Unexpected export error",
      500,
    );
  }
}

/**
 * Extract file data from a request body, supporting both raw binary
 * and multipart form data uploads.
 *
 * Shared between validate and import-preflight handlers.
 */
async function extractFileData(
  req: Request,
): Promise<{ data: Uint8Array } | { error: Response }> {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    try {
      const formData = await req.formData();
      const file = formData.get("file");
      if (!file || !(file instanceof Blob)) {
        return {
          error: httpError(
            "BAD_REQUEST",
            'Multipart upload requires a "file" field',
            400,
          ),
        };
      }
      return { data: new Uint8Array(await file.arrayBuffer()) };
    } catch (err) {
      log.error({ err }, "Failed to parse multipart form data");
      return {
        error: httpError("BAD_REQUEST", "Invalid multipart form data", 400),
      };
    }
  }

  // Treat as raw binary body
  try {
    const arrayBuffer = await req.arrayBuffer();
    return { data: new Uint8Array(arrayBuffer) };
  } catch (err) {
    log.error({ err }, "Failed to read request body");
    return {
      error: httpError("BAD_REQUEST", "Failed to read request body", 400),
    };
  }
}

/**
 * POST /v1/migrations/import-preflight
 *
 * Dry-run import analysis. Accepts a .vbundle archive upload, validates it,
 * and returns a detailed report of what would change if the bundle were
 * actually imported — without modifying any data on disk.
 *
 * The file can be sent as:
 * - Raw binary body with Content-Type: application/octet-stream
 * - Multipart form data with a "file" field
 *
 * Returns:
 *   200: {
 *     can_import: boolean,
 *     summary: { total_files, files_to_create, files_to_overwrite, files_unchanged },
 *     files: [{ path, action, bundle_size, current_size, bundle_sha256, current_sha256 }],
 *     conflicts: [{ code, message, path? }],
 *     manifest: { ... }
 *   }
 *   200: { can_import: false, validation: { is_valid: false, errors: [...] } }
 *        (when the bundle itself is invalid)
 *   400: Standard error envelope for missing/empty body
 *   500: Standard error envelope for unexpected failures
 *
 * Auth: Requires settings.write scope. Allowed for actor, svc_gateway, svc_daemon, local.
 */
export async function handleMigrationImportPreflight(
  req: Request,
): Promise<Response> {
  const extracted = await extractFileData(req);
  if ("error" in extracted) {
    return extracted.error;
  }

  const fileData = extracted.data;
  if (fileData.length === 0) {
    return httpError(
      "BAD_REQUEST",
      "Request body is empty — a .vbundle file is required",
      400,
    );
  }

  try {
    // Step 1: Validate the bundle
    const validationResult = validateVBundle(fileData);

    if (!validationResult.is_valid || !validationResult.manifest) {
      return Response.json({
        can_import: false,
        validation: {
          is_valid: false,
          errors: validationResult.errors,
        },
      });
    }

    // Step 2: Analyze what would change on import
    const pathResolver = new DefaultPathResolver(
      getDbPath(),
      getWorkspaceConfigPath(),
      join(getRootDir(), "protected"),
      getWorkspaceSkillsDir(),
    );

    const report = analyzeImport({
      manifest: validationResult.manifest,
      pathResolver,
    });

    return Response.json(report);
  } catch (err) {
    log.error({ err }, "Unexpected error during import preflight analysis");
    return httpError(
      "INTERNAL_ERROR",
      err instanceof Error ? err.message : "Unexpected import preflight error",
      500,
    );
  }
}

/**
 * POST /v1/migrations/import
 *
 * Commits a .vbundle archive import to disk. This is a destructive operation
 * that writes bundle files to their target locations, replacing existing data.
 *
 * The import process:
 * 1. Validates the bundle (validation before any state mutation)
 * 2. Extracts files from the archive
 * 3. Backs up existing files before overwriting
 * 4. Writes bundle files to disk
 * 5. Verifies post-write integrity (SHA-256 check)
 * 6. Returns a detailed report of what was imported
 *
 * The file can be sent as:
 * - Raw binary body with Content-Type: application/octet-stream
 * - Multipart form data with a "file" field
 *
 * Returns:
 *   200: {
 *     success: true,
 *     summary: { total_files, files_created, files_overwritten, files_skipped, backups_created },
 *     files: [{ path, disk_path, action, size, sha256, backup_path }],
 *     manifest: { ... },
 *     warnings: [...]
 *   }
 *   200: { success: false, reason: "validation_failed", errors: [...] }
 *   400: Standard error envelope for missing/empty body
 *   500: Standard error envelope for unexpected failures
 *
 * Auth: Requires settings.write scope. Allowed for actor, svc_gateway, svc_daemon, local.
 */
export async function handleMigrationImport(req: Request): Promise<Response> {
  const extracted = await extractFileData(req);
  if ("error" in extracted) {
    return extracted.error;
  }

  const fileData = extracted.data;
  if (fileData.length === 0) {
    return httpError(
      "BAD_REQUEST",
      "Request body is empty — a .vbundle file is required",
      400,
    );
  }

  try {
    // Validate the bundle before closing the DB to avoid an unnecessary
    // close/reopen cycle when the bundle is invalid. Pass the validated
    // manifest and entries to commitImport so it skips re-validation
    // (avoids holding two copies of decompressed data in memory).
    const validation = validateVBundle(fileData);
    if (!validation.is_valid) {
      return Response.json({
        success: false,
        reason: "validation_failed",
        errors: validation.errors,
      });
    }

    const pathResolver = new DefaultPathResolver(
      getDbPath(),
      getWorkspaceConfigPath(),
      join(getRootDir(), "protected"),
      getWorkspaceSkillsDir(),
    );

    // Close the live SQLite connection before overwriting assistant.db on disk.
    // The singleton will be lazily reopened on the next getDb() call.
    resetDb();

    const result = commitImport({
      archiveData: fileData,
      pathResolver,
      preValidatedManifest: validation.manifest,
      preValidatedEntries: validation.entries,
    });

    if (!result.ok) {
      if (result.reason === "validation_failed") {
        return Response.json({
          success: false,
          reason: "validation_failed",
          errors: result.errors,
        });
      }

      if (result.reason === "extraction_failed") {
        return Response.json(
          {
            success: false,
            reason: "extraction_failed",
            message: result.message,
          },
          { status: 500 },
        );
      }

      // write_failed
      return Response.json(
        {
          success: false,
          reason: "write_failed",
          message: result.message,
          ...(result.partial_report
            ? { partial_report: result.partial_report }
            : {}),
        },
        { status: 500 },
      );
    }

    // Invalidate in-process config cache so imported settings.json takes effect
    invalidateConfigCache();

    return Response.json(result.report);
  } catch (err) {
    log.error({ err }, "Unexpected error during import commit");
    return httpError(
      "INTERNAL_ERROR",
      err instanceof Error ? err.message : "Unexpected import error",
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function migrationRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "migrations/validate",
      method: "POST",
      handler: async ({ req }) => handleMigrationValidate(req),
    },
    {
      endpoint: "migrations/export",
      method: "POST",
      handler: async ({ req }) => handleMigrationExport(req),
    },
    {
      endpoint: "migrations/import-preflight",
      method: "POST",
      handler: async ({ req }) => handleMigrationImportPreflight(req),
    },
    {
      endpoint: "migrations/import",
      method: "POST",
      handler: async ({ req }) => handleMigrationImport(req),
    },
  ];
}
