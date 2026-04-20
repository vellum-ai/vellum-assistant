/**
 * Route handlers for migration endpoints.
 *
 * POST /v1/migrations/validate        — validate a .vbundle archive upload.
 * POST /v1/migrations/export          — generate and download a .vbundle archive.
 * POST /v1/migrations/import-preflight — dry-run import analysis of a .vbundle archive.
 * POST /v1/migrations/import          — commit a .vbundle archive import to disk.
 *
 * Accepts raw binary body (Content-Type: application/octet-stream),
 * multipart form data with a "file" field, or — on /import only — a JSON
 * body of shape `{ "url": "<signed-gcs-url>" }` that causes the daemon to
 * fetch the bundle from GCS and stream it through `streamCommitImport`.
 * Returns structured validation results with is_valid flag and detailed
 * error descriptions.
 */

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { Database } from "bun:sqlite";

import { z } from "zod";

import { invalidateConfigCache } from "../../config/loader.js";
import { getDb, resetDb } from "../../memory/db-connection.js";
import { validateMigrationState } from "../../memory/migrations/validate-migration-state.js";
import { clearCache as clearTrustCache } from "../../permissions/trust-store.js";
import {
  bulkSetSecureKeysAsync,
  getSecureKeyResultAsync,
  listSecureKeysAsync,
} from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import {
  getDbPath,
  getWorkspaceDir,
  getWorkspaceHooksDir,
} from "../../util/platform.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import {
  validateGcsSignedUrl,
  type ValidateGcsSignedUrlOptions,
} from "../migrations/gcs-signed-url.js";
import { streamExportVBundle } from "../migrations/vbundle-builder.js";
import {
  analyzeImport,
  DefaultPathResolver,
} from "../migrations/vbundle-import-analyzer.js";
import {
  commitImport,
  extractCredentialsFromBundle,
  type ImportCommitReport,
  type ImportCommitResult,
} from "../migrations/vbundle-importer.js";
import { streamCommitImport } from "../migrations/vbundle-streaming-importer.js";
import { validateVBundle } from "../migrations/vbundle-validator.js";

/** Credentials with this prefix are platform-identity keys and must not be imported. */
const PLATFORM_CREDENTIAL_PREFIX = "vellum:";

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

  let cleanup: (() => Promise<void>) | undefined;

  try {
    // Read all stored credentials to include in the export bundle
    const credentialList = await listSecureKeysAsync();
    const credentials: Array<{ account: string; value: string }> = [];
    if (credentialList.unreachable) {
      log.warn(
        "Credential store is unreachable — export will not include credentials",
      );
    } else {
      for (const account of credentialList.accounts) {
        const result = await getSecureKeyResultAsync(account);
        if (result.unreachable) {
          log.warn(
            { account },
            "Credential store unreachable when reading credential — skipping",
          );
        } else if (result.value != null) {
          credentials.push({ account, value: result.value });
        }
      }
    }

    const result = await streamExportVBundle({
      // hooksDir is intentionally omitted — hooks now live under workspace/hooks/
      // and are included in the workspace walk. Passing hooksDir separately would
      // export them twice (once as workspace/hooks/... and again as hooks/...).
      workspaceDir: getWorkspaceDir(),
      source: "runtime-export",
      description,
      credentials,
      checkpoint: () => {
        const dbPath = getDbPath();
        try {
          const db = new Database(dbPath);
          try {
            db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          } finally {
            db.close();
          }
        } catch (err) {
          // Best-effort: if the DB can't be checkpointed (e.g. not a valid
          // SQLite file, missing WAL, etc.) we still proceed with the export
          // using whatever is on disk.
          log.warn(
            { err },
            "WAL checkpoint failed — exporting without checkpoint",
          );
        }
      },
    });

    cleanup = result.cleanup;
    const { tempPath, size, manifest } = result;

    const timestamp = manifest.created_at.replace(/[:.]/g, "-");
    const filename = `export-${timestamp}.vbundle`;

    const fileStream = createReadStream(tempPath);
    fileStream.on("close", () => {
      cleanup?.();
      cleanup = undefined;
    });

    const body = Readable.toWeb(fileStream) as unknown as ReadableStream;

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(size),
        "X-Vbundle-Schema-Version": manifest.schema_version,
        "X-Vbundle-Manifest-Sha256": manifest.manifest_sha256,
        "X-Vbundle-Credentials-Included": String(credentials.length),
      },
    });
  } catch (err) {
    await cleanup?.();
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

    const pathResolver = new DefaultPathResolver(
      getWorkspaceDir(),
      getWorkspaceHooksDir(),
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
 * The bundle can be supplied in any of three ways:
 * - Raw binary body with Content-Type: application/octet-stream
 * - Multipart form data with a "file" field
 * - JSON body `{ "url": "<signed-gcs-url>" }` (Content-Type:
 *   application/json). The daemon fetches and streams the archive
 *   through `streamCommitImport`, so peak memory stays bounded by a
 *   single tar entry rather than bundle size.
 *
 * Returns (all three paths):
 *   200: {
 *     success: true,
 *     summary: { total_files, files_created, files_overwritten, files_skipped, backups_created },
 *     files: [{ path, disk_path, action, size, sha256, backup_path }],
 *     manifest: { ... },
 *     warnings: [...]
 *   }
 *   200: { success: false, reason: "validation_failed", errors: [...] }
 *   400: Standard error envelope for missing/empty body or malformed URL
 *   500: Standard error envelope for unexpected failures
 *   502: { success: false, reason: "fetch_failed", upstream_status?: number }
 *        (URL path only — upstream GCS fetch failed)
 *
 * Auth: Requires settings.write scope. Allowed for actor, svc_gateway, svc_daemon, local.
 */
export async function handleMigrationImport(req: Request): Promise<Response> {
  // JSON body means the caller is asking us to fetch the bundle from a
  // signed URL and stream it through the importer. This keeps the daemon's
  // peak memory bounded by one tar entry instead of bundle size, which is
  // the whole point of supporting URL-based imports for large bundles.
  //
  // Raw-bytes path (octet-stream / multipart) is untouched below.
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return handleMigrationImportFromUrl(req);
  }

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
      getWorkspaceDir(),
      getWorkspaceHooksDir(),
    );

    // Close the live SQLite connection before overwriting assistant.db on disk.
    // The singleton will be lazily reopened on the next getDb() call.
    resetDb();

    const result = commitImport({
      archiveData: fileData,
      pathResolver,
      preValidatedManifest: validation.manifest,
      preValidatedEntries: validation.entries,
      workspaceDir: getWorkspaceDir(),
    });

    if (!result.ok) {
      return importCommitFailureResponse(result);
    }

    // Import credentials from the bundle into CES (non-blocking — failures
    // are logged as warnings but do not fail the overall import).
    let credentialsImported: CredentialImportSummary | undefined;

    if (validation.entries) {
      const bundleCredentials = extractCredentialsFromBundle(
        validation.entries,
        validation.manifest!,
      );
      credentialsImported = await importBundleCredentialsIntoCes(
        bundleCredentials,
        result.report,
      );
    }

    // Invalidate in-process caches so imported settings.json and trust.json take effect
    invalidateConfigCache();
    clearTrustCache();

    // Check whether the imported database contains migration checkpoints from
    // a newer version. This is non-blocking — the import has already
    // succeeded — but we surface a warning so the caller knows some data may
    // not be fully compatible with this daemon's schema.
    appendNewerMigrationWarningsIfAny(result.report);

    return importCommitSuccessResponse(result.report, credentialsImported);
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
// URL-body variant of POST /v1/migrations/import
// ---------------------------------------------------------------------------

/** 60 minutes — matches the gateway's upstream fetch deadline. */
const URL_FETCH_TIMEOUT_MS = 60 * 60 * 1000;

const MigrationImportUrlBody = z.object({ url: z.string().min(1) });

/**
 * Test seam: the integration test needs to point the validator at a local
 * HTTP server fixture. Production callers never pass this — the default
 * keeps the validator strict (GCS host, HTTPS only, no explicit port).
 */
let urlValidatorOptions: ValidateGcsSignedUrlOptions | undefined;

/**
 * Test-only: override the allowed-host list used by the URL-body import
 * handler. Call with `undefined` (or no arguments) to reset to production
 * defaults. This is intentionally not exported from the module's public
 * surface — tests import it directly from this file.
 */
export function _setUrlImportValidatorOptionsForTests(
  options: ValidateGcsSignedUrlOptions | undefined,
): void {
  urlValidatorOptions = options;
}

/**
 * Handle a JSON `{ "url": "..." }` body on POST /v1/migrations/import.
 *
 * Fetches the signed URL, pipes the response body through the streaming
 * importer, and returns the same response shapes as the raw-bytes path.
 * The signed URL is never logged or included in error responses — only the
 * extracted host and path make it into logs.
 */
async function handleMigrationImportFromUrl(req: Request): Promise<Response> {
  // ── 1. Parse JSON body ────────────────────────────────────────────────
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to parse JSON body on migration import URL request",
    );
    return httpError("BAD_REQUEST", "Invalid JSON body", 400);
  }

  const parsed = MigrationImportUrlBody.safeParse(rawBody);
  if (!parsed.success) {
    return httpError(
      "BAD_REQUEST",
      "Request body must be { url: string } with a non-empty url",
      400,
    );
  }

  // ── 2. Validate the URL (defense-in-depth; never log `parsed.data.url`).
  const validated = validateGcsSignedUrl(parsed.data.url, urlValidatorOptions);
  if (!validated.ok) {
    // `reason` is a stable enum string and safe to include. The raw URL is
    // not — it may contain a live signature. Callers get the reason so they
    // can correct the URL without leaking anything into observability.
    log.warn({ reason: validated.reason }, "Rejected migration import URL");
    return httpError("BAD_REQUEST", `Invalid URL: ${validated.reason}`, 400);
  }

  log.info(
    { host: validated.host, path: validated.path },
    "migration import from URL",
  );

  const startedAt = Date.now();

  // ── 3. Fetch the URL ──────────────────────────────────────────────────
  let upstream: Response;
  try {
    upstream = await fetch(parsed.data.url, {
      signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    log.error(
      {
        host: validated.host,
        path: validated.path,
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to fetch migration import URL",
    );
    return Response.json(
      { success: false, reason: "fetch_failed" },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    log.error(
      {
        host: validated.host,
        path: validated.path,
        upstream_status: upstream.status,
      },
      "Migration import URL fetch returned non-2xx",
    );
    // Drain the body so the underlying socket can be released promptly.
    try {
      await upstream.body?.cancel();
    } catch {
      /* best effort */
    }
    return Response.json(
      {
        success: false,
        reason: "fetch_failed",
        upstream_status: upstream.status,
      },
      { status: 502 },
    );
  }

  if (!upstream.body) {
    log.error(
      { host: validated.host, path: validated.path },
      "Migration import URL fetch returned no body",
    );
    return Response.json(
      { success: false, reason: "fetch_failed" },
      { status: 502 },
    );
  }

  // ── 4. Stream the response through the importer ──────────────────────
  // Convert the WHATWG ReadableStream from fetch() into a Node Readable so
  // the tar-stream / gunzip / hash-verifier pipeline inside
  // streamCommitImport can consume it via `.pipe()`.
  const nodeStream = Readable.fromWeb(
    upstream.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
  );

  const pathResolver = new DefaultPathResolver(
    getWorkspaceDir(),
    getWorkspaceHooksDir(),
  );

  // streamCommitImport does its own resetDb() internally before the atomic
  // swap, so we don't need to call it here.
  let result: ImportCommitResult;
  // Track credential-import outcome for inclusion in the success response.
  // The streaming importer invokes our callback only after the atomic swap,
  // so filling this in here is safe.
  let credentialsImported: CredentialImportSummary | undefined;
  // Per-invocation warning collector — scoped to this request so concurrent
  // URL imports can't trample each other's warnings.
  const credentialImportWarningSink: CredentialWarningSink = { warnings: [] };

  try {
    result = await streamCommitImport({
      source: nodeStream,
      pathResolver,
      workspaceDir: getWorkspaceDir(),
      importCredentials: async (bundleCredentials) => {
        // We can't mutate `result.report.warnings` in place here — the
        // streaming importer hasn't returned its report yet. Accumulate
        // into a sidecar and merge into the final report below.
        credentialsImported = await importBundleCredentialsIntoCes(
          bundleCredentials,
          credentialImportWarningSink,
        );
      },
    });
  } catch (err) {
    log.error(
      {
        host: validated.host,
        path: validated.path,
        err: err instanceof Error ? err.message : String(err),
      },
      "streamCommitImport threw during URL-body import",
    );
    return httpError(
      "INTERNAL_ERROR",
      err instanceof Error ? err.message : "Unexpected import error",
      500,
    );
  }

  if (!result.ok) {
    log.warn(
      {
        host: validated.host,
        path: validated.path,
        reason: result.reason,
      },
      "streamCommitImport returned failure during URL-body import",
    );
    return importCommitFailureResponse(result);
  }

  // Merge any warnings accumulated by the credential-import callback into
  // the final report.
  if (credentialImportWarningSink.warnings.length > 0) {
    result.report.warnings.push(...credentialImportWarningSink.warnings);
  }

  // streamCommitImport already invalidated config + trust caches inside its
  // post-swap cleanup. We only need to check whether the newly-imported DB
  // carries migration checkpoints from a newer daemon version.
  appendNewerMigrationWarningsIfAny(result.report);

  const elapsedMs = Date.now() - startedAt;
  log.info(
    {
      host: validated.host,
      path: validated.path,
      files_written: result.report.summary.files_created,
      bytes_written: result.report.files.reduce((n, f) => n + f.size, 0),
      elapsed_ms: elapsedMs,
    },
    "Migration import from URL complete",
  );

  return importCommitSuccessResponse(result.report, credentialsImported);
}

// ---------------------------------------------------------------------------
// Shared helpers for raw-bytes and URL paths
// ---------------------------------------------------------------------------

interface CredentialImportSummary {
  total: number;
  succeeded: number;
  failed: number;
  failedAccounts: string[];
  skippedPlatform: number;
}

/**
 * Minimal surface the credential-import helper needs to stash warnings —
 * either a full `ImportCommitReport` (raw-bytes path, after commitImport
 * returns) or an ephemeral per-request collector (streaming path, where the
 * report doesn't exist yet when the callback fires).
 */
interface CredentialWarningSink {
  warnings: string[];
}

/**
 * Filter platform-identity (vellum:*) credentials out of the bundle, push
 * user credentials into CES via `bulkSetSecureKeysAsync`, and return a
 * structured summary. Never throws — CES failures become report warnings.
 */
async function importBundleCredentialsIntoCes(
  bundleCredentials: Array<{ account: string; value: string }>,
  warningSink: CredentialWarningSink,
): Promise<CredentialImportSummary | undefined> {
  // Filter out platform-identity credentials (vellum:*) — these are
  // environment-specific and must not overwrite the target's own identity.
  const userCredentials = bundleCredentials.filter(
    (c) => !c.account.startsWith(PLATFORM_CREDENTIAL_PREFIX),
  );
  const skippedPlatform = bundleCredentials.length - userCredentials.length;
  if (skippedPlatform > 0) {
    log.info(`Skipped ${skippedPlatform} platform credential(s) from import`);
  }

  if (userCredentials.length === 0) {
    if (skippedPlatform > 0) {
      // All credentials in the bundle were platform credentials — report
      // the skip count even though nothing was sent to CES.
      return {
        total: 0,
        succeeded: 0,
        failed: 0,
        failedAccounts: [],
        skippedPlatform,
      };
    }
    return undefined;
  }

  try {
    const credResults = await bulkSetSecureKeysAsync(userCredentials);
    const failedResults = credResults.filter((r) => !r.ok);
    if (failedResults.length > 0) {
      log.warn(
        { failed: failedResults.map((f) => f.account) },
        "Some credentials failed to import",
      );
    }
    log.info(
      { total: userCredentials.length, failed: failedResults.length },
      "Credential import complete",
    );
    const succeeded = userCredentials.length - failedResults.length;
    if (failedResults.length > 0) {
      warningSink.warnings.push(
        `Imported ${succeeded} credential(s), ${failedResults.length} failed`,
      );
    }
    return {
      total: userCredentials.length,
      succeeded,
      failed: failedResults.length,
      failedAccounts: failedResults.map((f) => f.account),
      skippedPlatform,
    };
  } catch (err) {
    log.warn({ err }, "Credential import failed entirely");
    warningSink.warnings.push(
      `Credential import failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      total: userCredentials.length,
      succeeded: 0,
      failed: userCredentials.length,
      failedAccounts: userCredentials.map((c) => c.account),
      skippedPlatform,
    };
  }
}

/**
 * Append a warning to `report` when the newly-imported database contains
 * migration checkpoints from a daemon version newer than this one. Silent
 * on any validation error — the import has already succeeded.
 */
function appendNewerMigrationWarningsIfAny(report: ImportCommitReport): void {
  try {
    const migrationValidation = validateMigrationState(getDb());
    if (migrationValidation.unknownCheckpoints.length > 0) {
      report.warnings.push(
        `Imported data contains ${migrationValidation.unknownCheckpoints.length} migration(s) from a newer version. Some data may not be fully compatible.`,
      );
    }
  } catch {
    // Don't fail the import if validation itself errors
  }
}

/**
 * Build a success Response from an ImportCommitReport. The report fields
 * are spread at the top level, with an optional `credentialsImported`
 * summary alongside.
 */
function importCommitSuccessResponse(
  report: ImportCommitReport,
  credentialsImported: CredentialImportSummary | undefined,
): Response {
  return Response.json({
    ...report,
    ...(credentialsImported ? { credentialsImported } : {}),
  });
}

/**
 * Map an `ImportCommitResult` failure to the Response shape callers of
 * `POST /v1/migrations/import` depend on. Status codes and body shapes
 * are part of the public contract and must remain stable.
 */
function importCommitFailureResponse(
  result: Extract<ImportCommitResult, { ok: false }>,
): Response {
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

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function migrationRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "migrations/validate",
      method: "POST",
      summary: "Validate a .vbundle archive",
      description:
        "Upload a .vbundle archive for validation. Accepts raw binary or multipart form data.",
      tags: ["migrations"],
      responseBody: z.object({
        is_valid: z.boolean(),
        errors: z.array(z.unknown()),
        manifest: z.object({}).passthrough(),
      }),
      handler: async ({ req }) => handleMigrationValidate(req),
    },
    {
      endpoint: "migrations/export",
      method: "POST",
      summary: "Export a .vbundle archive",
      description:
        "Generate and download a .vbundle archive of the assistant's data. Optional JSON body for metadata.",
      tags: ["migrations"],
      requestBody: z.object({
        description: z.string().describe("Human-readable export description"),
      }),
      handler: async ({ req }) => handleMigrationExport(req),
    },
    {
      endpoint: "migrations/import-preflight",
      method: "POST",
      summary: "Dry-run import analysis",
      description:
        "Validate a .vbundle archive and return a report of what would change on import without modifying data.",
      tags: ["migrations"],
      responseBody: z.object({
        can_import: z.boolean(),
        summary: z.object({}).passthrough(),
        files: z.array(z.unknown()),
        conflicts: z.array(z.unknown()),
        manifest: z.object({}).passthrough(),
      }),
      handler: async ({ req }) => handleMigrationImportPreflight(req),
    },
    {
      endpoint: "migrations/import",
      method: "POST",
      summary: "Import a .vbundle archive",
      description:
        "Commit a .vbundle archive import to disk — destructive. Accepts the bundle as raw bytes (application/octet-stream), multipart/form-data, or a JSON body carrying a signed URL the daemon fetches and streams through the importer.",
      tags: ["migrations"],
      requestBodies: [
        {
          contentType: "application/octet-stream",
          schema: {
            type: "string",
            format: "binary",
            description: "Raw .vbundle archive bytes.",
          },
        },
        {
          contentType: "multipart/form-data",
          schema: {
            type: "object",
            properties: {
              file: {
                type: "string",
                format: "binary",
                description: "The .vbundle archive uploaded as a file field.",
              },
            },
            required: ["file"],
          },
        },
        {
          contentType: "application/json",
          schema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                format: "uri",
                description:
                  "A signed GCS URL pointing to the .vbundle archive. The daemon fetches the URL and streams the body through the importer.",
              },
            },
            required: ["url"],
          },
        },
      ],
      additionalResponses: {
        "502": {
          description:
            "Upstream fetch failed (URL body only). Body shape: { success: false, reason: 'fetch_failed', upstream_status?: number }.",
          schema: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              reason: { type: "string", enum: ["fetch_failed"] },
              upstream_status: { type: "integer" },
            },
            required: ["success", "reason"],
          },
        },
      },
      responseBody: z.object({
        success: z.boolean(),
        summary: z.object({}).passthrough(),
        files: z.array(z.unknown()),
        manifest: z.object({}).passthrough(),
        warnings: z.array(z.unknown()),
      }),
      handler: async ({ req }) => handleMigrationImport(req),
    },
  ];
}
