/**
 * Route handlers for migration endpoints.
 *
 * POST /v1/migrations/validate — validate a .vbundle archive upload.
 * POST /v1/migrations/export  — generate and download a .vbundle archive.
 *
 * Accepts raw binary body (Content-Type: application/octet-stream) or
 * multipart form data with a "file" field. Returns structured validation
 * results with is_valid flag and detailed error descriptions.
 */

import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import { buildSkeletonVBundle } from "../migrations/vbundle-builder.js";
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
 * Generates a .vbundle archive skeleton and returns it as a binary download.
 * The archive contains the correct file layout structure (manifest, db
 * placeholder, config directory) but does not populate actual conversation
 * or memory data — that is reserved for PR-3.
 *
 * Accepts an optional JSON body:
 *   { "description": "Human-readable export description" }
 *
 * Returns:
 *   200: Binary .vbundle archive (Content-Type: application/octet-stream)
 *        with Content-Disposition header for download.
 *   500: Standard error envelope for unexpected failures.
 *
 * Auth: Requires settings.write scope. Allowed for actor, svc_gateway, ipc.
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
    const { archive, manifest } = buildSkeletonVBundle({
      source: "runtime-export",
      description,
    });

    const timestamp = manifest.created_at.replace(/[:.]/g, "-");
    const filename = `export-${timestamp}.vbundle`;

    return new Response(archive, {
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
