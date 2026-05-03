/**
 * Shared transport methods for managed and runtime migration APIs.
 *
 * Provides typed functions for each migration endpoint, usable by
 * client web views (macOS/iOS WKWebView), the gateway, or any
 * TypeScript consumer that needs to call migration APIs.
 *
 * Two target APIs:
 *
 *   Runtime (local daemon):
 *     POST /v1/migrations/validate
 *     POST /v1/migrations/export
 *     POST /v1/migrations/import-preflight
 *     POST /v1/migrations/import
 *
 *   Managed (platform/Django):
 *     POST /v1/migrations/validate/
 *     POST /v1/migrations/export/
 *     POST /v1/migrations/import-preflight/
 *     POST /v1/migrations/import/
 *     GET  /v1/migrations/export/{job_id}/status/
 *     GET  /v1/migrations/import/{job_id}/status/
 *
 * All methods accept a `fetchFn` parameter for testability (defaults to
 * the global `fetch`). Auth headers are passed via `TransportConfig`.
 */

// ---------------------------------------------------------------------------
// Transport configuration
// ---------------------------------------------------------------------------

export type MigrationTarget = "runtime" | "managed";

export interface TransportConfig {
  /** Base URL of the target API (e.g. "https://platform.vellum.ai"). */
  baseURL: string;
  /** Which API surface to target. Managed endpoints use trailing slashes. */
  target: MigrationTarget;
  /** Authorization header value (e.g. "Bearer <jwt>" or session token). */
  authHeader?: string;
  /** Header name for auth. Defaults to "Authorization" for runtime, "X-Session-Token" for managed. */
  authHeaderName?: string;
  /**
   * Additional headers to include with every request.
   * Merged after Content-Type but before auth-header injection,
   * so an explicit auth header from the transport always wins
   * over a same-named entry in defaultHeaders.
   */
  defaultHeaders?: Record<string, string>;
  /** Custom fetch implementation for testing or environments without global fetch. */
  fetchFn?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Shared types — validation
// ---------------------------------------------------------------------------

export interface ValidationError {
  code: string;
  message: string;
  path?: string;
}

interface ManifestFileEntry {
  path: string;
  sha256: string;
  size_bytes: number;
}

interface ManifestAssistantInfo {
  id: string;
  name: string;
  runtime_version: string;
}

interface ManifestOrigin {
  mode: "managed" | "self-hosted-remote" | "self-hosted-local";
  platform_version?: string;
  hostname?: string;
}

interface ManifestCompatibility {
  min_runtime_version: string;
  max_runtime_version: string | null;
}

interface ManifestExportOptions {
  include_logs: boolean;
  include_browser_state: boolean;
  include_memory_vectors: boolean;
}

export interface Manifest {
  schema_version: number;
  bundle_id: string;
  created_at: string;
  assistant: ManifestAssistantInfo;
  origin: ManifestOrigin;
  compatibility: ManifestCompatibility;
  contents: ManifestFileEntry[];
  checksum: string;
  secrets_redacted: boolean;
  export_options: ManifestExportOptions;
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export interface ValidateSuccessResponse {
  is_valid: true;
  errors: ValidationError[];
  manifest: Manifest;
}

export interface ValidateFailureResponse {
  is_valid: false;
  errors: ValidationError[];
}

export type ValidateResponse =
  | ValidateSuccessResponse
  | ValidateFailureResponse;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Runtime export returns the binary archive directly. */
export interface ExportRuntimeResult {
  ok: true;
  archive: ArrayBuffer;
  filename: string;
  schemaVersion: number;
  checksum: string;
}

/** Managed export initiates an async job and returns a job ID. */
export interface ExportManagedResult {
  ok: true;
  jobId: string;
  status: string;
}

type ExportResult = ExportRuntimeResult | ExportManagedResult;

// ---------------------------------------------------------------------------
// Import preflight
// ---------------------------------------------------------------------------

export interface ImportPreflightFileReport {
  path: string;
  action: "create" | "overwrite" | "unchanged" | "skip";
  bundle_size: number;
  current_size: number | null;
  bundle_sha256: string;
  current_sha256: string | null;
}

export interface ImportPreflightConflict {
  code: string;
  message: string;
  path?: string;
}

export interface ImportPreflightSuccessResponse {
  can_import: true;
  summary: {
    total_files: number;
    files_to_create: number;
    files_to_overwrite: number;
    files_unchanged: number;
    files_to_skip: number;
  };
  files: ImportPreflightFileReport[];
  conflicts: ImportPreflightConflict[];
  manifest: Manifest;
}

export interface ImportPreflightValidationFailedResponse {
  can_import: false;
  validation: {
    is_valid: false;
    errors: ValidationError[];
  };
}

export interface ImportPreflightConflictResponse {
  can_import: false;
  summary: {
    total_files: number;
    files_to_create: number;
    files_to_overwrite: number;
    files_unchanged: number;
    files_to_skip: number;
  };
  files: ImportPreflightFileReport[];
  conflicts: ImportPreflightConflict[];
  manifest: Manifest;
}

export type ImportPreflightResponse =
  | ImportPreflightSuccessResponse
  | ImportPreflightValidationFailedResponse
  | ImportPreflightConflictResponse;

// ---------------------------------------------------------------------------
// Import commit
// ---------------------------------------------------------------------------

export interface ImportedFileReport {
  path: string;
  disk_path: string;
  action: "created" | "overwritten" | "skipped";
  size: number;
  sha256: string;
  backup_path: string | null;
}

export interface ImportCommitSuccessResponse {
  success: true;
  summary: {
    total_files: number;
    files_created: number;
    files_overwritten: number;
    files_skipped: number;
    backups_created: number;
  };
  files: ImportedFileReport[];
  manifest: Manifest;
  warnings: string[];
  credentialsImported?: {
    total: number;
    succeeded: number;
    failed: number;
    failedAccounts: string[];
    skippedPlatform?: number;
  };
}

export interface ImportCommitFailureResponse {
  success: false;
  reason: "validation_failed" | "extraction_failed" | "write_failed";
  errors?: ValidationError[];
  message?: string;
  partial_report?: unknown;
}

export type ImportCommitResponse =
  | ImportCommitSuccessResponse
  | ImportCommitFailureResponse;

// ---------------------------------------------------------------------------
// Job status polling (managed only)
// ---------------------------------------------------------------------------

export interface JobStatusPending {
  status: "pending" | "processing";
  jobId: string;
  progress?: number;
}

export interface JobStatusComplete {
  status: "complete";
  jobId: string;
  downloadUrl?: string;
  result?: unknown;
}

export interface JobStatusFailed {
  status: "failed";
  jobId: string;
  error: string;
}

export type JobStatusResponse =
  | JobStatusPending
  | JobStatusComplete
  | JobStatusFailed;

// ---------------------------------------------------------------------------
// Transport error
// ---------------------------------------------------------------------------

export class MigrationTransportError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(message: string, statusCode: number, responseBody: string) {
    super(message);
    this.name = "MigrationTransportError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveFetch(config: TransportConfig): typeof fetch {
  return config.fetchFn ?? globalThis.fetch;
}

function buildURL(config: TransportConfig, path: string): string {
  const base = config.baseURL.replace(/\/+$/, "");
  const trailingSlash = config.target === "managed" ? "/" : "";
  return `${base}/v1/migrations/${path}${trailingSlash}`;
}

function buildHeaders(
  config: TransportConfig,
  contentType?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const headerKeysByLowerName = new Map<string, string>();

  const setHeader = (headerName: string, headerValue: string): void => {
    const lowerName = headerName.toLowerCase();
    const existingHeaderName = headerKeysByLowerName.get(lowerName);
    if (existingHeaderName && existingHeaderName !== headerName) {
      delete headers[existingHeaderName];
    }
    headerKeysByLowerName.set(lowerName, headerName);
    headers[headerName] = headerValue;
  };

  if (contentType) {
    setHeader("Content-Type", contentType);
  }

  // Merge defaultHeaders after Content-Type but before auth injection
  if (config.defaultHeaders) {
    for (const [headerName, headerValue] of Object.entries(
      config.defaultHeaders,
    )) {
      setHeader(headerName, headerValue);
    }
  }

  // Auth header is applied last so it always wins over defaultHeaders
  if (config.authHeader) {
    const headerName =
      config.authHeaderName ??
      (config.target === "managed" ? "X-Session-Token" : "Authorization");
    setHeader(headerName, config.authHeader);
  }

  return headers;
}

async function assertOk(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable>");
    throw new MigrationTransportError(
      `${context}: HTTP ${response.status}`,
      response.status,
      body,
    );
  }
}

// ---------------------------------------------------------------------------
// Transport methods
// ---------------------------------------------------------------------------

/**
 * Validate a .vbundle archive.
 *
 * Sends the archive as binary body and returns structured validation results.
 */
export async function validateBundle(
  config: TransportConfig,
  fileData: ArrayBuffer,
): Promise<ValidateResponse> {
  const doFetch = resolveFetch(config);
  const url = buildURL(config, "validate");

  const response = await doFetch(url, {
    method: "POST",
    headers: buildHeaders(config, "application/octet-stream"),
    body: fileData,
  });

  await assertOk(response, "validate");
  return (await response.json()) as ValidateResponse;
}

/**
 * Export assistant data as a .vbundle archive.
 *
 * Runtime target: returns the binary archive directly.
 * Managed target: initiates an async export job and returns the job ID.
 */
export async function exportBundle(
  config: TransportConfig,
  options?: { description?: string },
): Promise<ExportResult> {
  const doFetch = resolveFetch(config);
  const url = buildURL(config, "export");

  const body = options?.description
    ? JSON.stringify({ description: options.description })
    : undefined;

  const contentType = body ? "application/json" : undefined;

  const response = await doFetch(url, {
    method: "POST",
    headers: buildHeaders(config, contentType),
    ...(body ? { body } : {}),
  });

  await assertOk(response, "export");

  if (config.target === "managed") {
    const json = (await response.json()) as {
      job_id: string;
      status: string;
    };
    return {
      ok: true,
      jobId: json.job_id,
      status: json.status,
    } as ExportManagedResult;
  }

  // Runtime returns the binary archive. The legacy
  // `X-Vbundle-Manifest-Sha256` response header name is preserved for
  // cross-version client compat — its value is now sourced from the
  // renamed manifest `checksum` field.
  const archive = await response.arrayBuffer();
  const schemaVersionHeader =
    response.headers.get("X-Vbundle-Schema-Version") ?? "";
  const parsedSchemaVersion = Number.parseInt(schemaVersionHeader, 10);
  return {
    ok: true,
    archive,
    filename:
      response.headers
        .get("Content-Disposition")
        ?.match(/filename="?(.+?)"?$/)?.[1] ?? "export.vbundle",
    schemaVersion: Number.isFinite(parsedSchemaVersion)
      ? parsedSchemaVersion
      : 0,
    checksum: response.headers.get("X-Vbundle-Manifest-Sha256") ?? "",
  } as ExportRuntimeResult;
}

/**
 * Dry-run import analysis of a .vbundle archive.
 *
 * Returns a detailed report of what would change if the bundle were imported,
 * without modifying any data on disk.
 */
export async function importPreflight(
  config: TransportConfig,
  fileData: ArrayBuffer,
): Promise<ImportPreflightResponse> {
  const doFetch = resolveFetch(config);
  const url = buildURL(config, "import-preflight");

  const response = await doFetch(url, {
    method: "POST",
    headers: buildHeaders(config, "application/octet-stream"),
    body: fileData,
  });

  await assertOk(response, "import-preflight");
  return (await response.json()) as ImportPreflightResponse;
}

/**
 * Commit a .vbundle archive import.
 *
 * This is a destructive operation that writes bundle files to their
 * target locations. For managed targets, this may initiate an async
 * import job.
 */
export async function importCommit(
  config: TransportConfig,
  fileData: ArrayBuffer,
): Promise<ImportCommitResponse> {
  const doFetch = resolveFetch(config);
  const url = buildURL(config, "import");

  const response = await doFetch(url, {
    method: "POST",
    headers: buildHeaders(config, "application/octet-stream"),
    body: fileData,
  });

  // The import endpoint can return non-2xx for server errors but
  // also returns 200 with success: false for validation/write failures.
  // We only throw on non-2xx status codes.
  if (response.status >= 500) {
    const body = await response.text().catch(() => "<unreadable>");
    throw new MigrationTransportError(
      `import: HTTP ${response.status}`,
      response.status,
      body,
    );
  }

  // 400-level errors are also transport failures
  if (response.status >= 400 && response.status < 500) {
    const body = await response.text().catch(() => "<unreadable>");
    throw new MigrationTransportError(
      `import: HTTP ${response.status}`,
      response.status,
      body,
    );
  }

  return (await response.json()) as ImportCommitResponse;
}

// ---------------------------------------------------------------------------
// Managed-only: job status polling
// ---------------------------------------------------------------------------

/**
 * Poll the status of a managed export job.
 *
 * Only applicable to managed targets. Runtime exports are synchronous
 * and do not require status polling.
 */
export async function pollExportStatus(
  config: TransportConfig,
  jobId: string,
): Promise<JobStatusResponse> {
  if (config.target !== "managed") {
    throw new Error("pollExportStatus is only supported for managed targets");
  }

  const doFetch = resolveFetch(config);
  const base = config.baseURL.replace(/\/+$/, "");
  const url = `${base}/v1/migrations/export/${encodeURIComponent(
    jobId,
  )}/status/`;

  const response = await doFetch(url, {
    method: "GET",
    headers: buildHeaders(config),
  });

  await assertOk(response, `export status (job ${jobId})`);
  const json = (await response.json()) as Record<string, unknown>;
  return {
    status: json.status as JobStatusResponse["status"],
    jobId: (json.job_id as string) ?? jobId,
    ...(json.download_url ? { downloadUrl: json.download_url as string } : {}),
    ...(json.progress !== undefined
      ? { progress: json.progress as number }
      : {}),
    ...(json.error ? { error: json.error as string } : {}),
    ...(json.result !== undefined ? { result: json.result } : {}),
  } as JobStatusResponse;
}

/**
 * Poll the status of a managed import job.
 *
 * Only applicable to managed targets. Runtime imports are synchronous
 * and do not require status polling.
 */
export async function pollImportStatus(
  config: TransportConfig,
  jobId: string,
): Promise<JobStatusResponse> {
  if (config.target !== "managed") {
    throw new Error("pollImportStatus is only supported for managed targets");
  }

  const doFetch = resolveFetch(config);
  const base = config.baseURL.replace(/\/+$/, "");
  const url = `${base}/v1/migrations/import/${encodeURIComponent(
    jobId,
  )}/status/`;

  const response = await doFetch(url, {
    method: "GET",
    headers: buildHeaders(config),
  });

  await assertOk(response, `import status (job ${jobId})`);
  const json = (await response.json()) as Record<string, unknown>;
  return {
    status: json.status as JobStatusResponse["status"],
    jobId: (json.job_id as string) ?? jobId,
    ...(json.progress !== undefined
      ? { progress: json.progress as number }
      : {}),
    ...(json.error ? { error: json.error as string } : {}),
    ...(json.result !== undefined ? { result: json.result } : {}),
  } as JobStatusResponse;
}

// ---------------------------------------------------------------------------
// Convenience: poll until terminal state
// ---------------------------------------------------------------------------

interface PollOptions {
  /** Polling interval in milliseconds. Defaults to 2000. */
  intervalMs?: number;
  /** Maximum number of polls before giving up. Defaults to 60. */
  maxAttempts?: number;
  /** Callback invoked on each poll with the latest status. */
  onProgress?: (status: JobStatusResponse) => void;
}

/**
 * Poll a managed job until it reaches a terminal state (complete or failed).
 *
 * Returns the final status response. Throws if maxAttempts is exceeded.
 */
export async function pollUntilComplete(
  config: TransportConfig,
  jobType: "export" | "import",
  jobId: string,
  options?: PollOptions,
): Promise<JobStatusComplete | JobStatusFailed> {
  const intervalMs = options?.intervalMs ?? 2000;
  const maxAttempts = options?.maxAttempts ?? 60;
  const pollFn = jobType === "export" ? pollExportStatus : pollImportStatus;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await pollFn(config, jobId);
    options?.onProgress?.(status);

    if (status.status === "complete" || status.status === "failed") {
      return status;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new MigrationTransportError(
    `${jobType} job ${jobId} did not complete within ${maxAttempts} polls`,
    0,
    "",
  );
}
