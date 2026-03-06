/**
 * Tests for the shared migration transport module.
 *
 * Covers:
 * - Runtime and managed target URL construction (trailing slashes, path format)
 * - Auth header injection (Authorization for runtime, X-Session-Token for managed)
 * - validate: success, validation failure, HTTP error
 * - export: runtime binary download, managed async job initiation
 * - import-preflight: success with report, validation failure
 * - import: success, failure response, HTTP error
 * - pollExportStatus / pollImportStatus: pending, complete, failed states
 * - pollUntilComplete: polls until terminal, progress callback, timeout
 * - Error handling: MigrationTransportError with status and body
 * - Retry/disabled: transport errors expose statusCode for retry decisions
 */

import { describe, expect, test } from "bun:test";

import type {
  ExportManagedResult,
  ExportRuntimeResult,
  ImportCommitResponse,
  ImportPreflightResponse,
  JobStatusResponse,
  TransportConfig,
  ValidateResponse,
} from "../runtime/migrations/migration-transport.js";
import {
  exportBundle,
  importCommit,
  importPreflight,
  MigrationTransportError,
  pollExportStatus,
  pollImportStatus,
  pollUntilComplete,
  validateBundle,
} from "../runtime/migrations/migration-transport.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a mock fetch function that returns a predefined response. */
function mockFetch(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): typeof fetch {
  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    const responseHeaders = new Headers(headers);
    if (
      typeof body === "object" &&
      body !== undefined &&
      !(body instanceof ArrayBuffer)
    ) {
      responseHeaders.set("Content-Type", "application/json");
      return new Response(JSON.stringify(body), {
        status,
        headers: responseHeaders,
      });
    }
    if (body instanceof ArrayBuffer) {
      return new Response(body, { status, headers: responseHeaders });
    }
    return new Response(String(body), { status, headers: responseHeaders });
  }) as unknown as typeof fetch;
}

/** Create a mock fetch that captures the request for inspection. */
function capturingFetch(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): { fetchFn: typeof fetch; captured: { url: string; init: RequestInit }[] } {
  const captured: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return mockFetch(status, body, headers)(url, init);
  }) as unknown as typeof fetch;
  return { fetchFn, captured };
}

function runtimeConfig(overrides?: Partial<TransportConfig>): TransportConfig {
  return {
    baseURL: "http://localhost:7821",
    target: "runtime",
    authHeader: "Bearer test-jwt",
    fetchFn: mockFetch(200, {}),
    ...overrides,
  };
}

function managedConfig(overrides?: Partial<TransportConfig>): TransportConfig {
  return {
    baseURL: "https://platform.vellum.ai",
    target: "managed",
    authHeader: "test-session-token",
    fetchFn: mockFetch(200, {}),
    ...overrides,
  };
}

const sampleFileData = new ArrayBuffer(16);

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

describe("URL construction", () => {
  test("runtime URLs have no trailing slash", async () => {
    const { fetchFn, captured } = capturingFetch(200, {
      is_valid: true,
      errors: [],
      manifest: {},
    });
    await validateBundle(runtimeConfig({ fetchFn }), sampleFileData);
    expect(captured[0].url).toBe(
      "http://localhost:7821/v1/migrations/validate",
    );
  });

  test("managed URLs have trailing slash", async () => {
    const { fetchFn, captured } = capturingFetch(200, {
      is_valid: true,
      errors: [],
      manifest: {},
    });
    await validateBundle(managedConfig({ fetchFn }), sampleFileData);
    expect(captured[0].url).toBe(
      "https://platform.vellum.ai/v1/migrations/validate/",
    );
  });

  test("base URL trailing slashes are normalized", async () => {
    const { fetchFn, captured } = capturingFetch(200, {
      is_valid: true,
      errors: [],
      manifest: {},
    });
    await validateBundle(
      runtimeConfig({ baseURL: "http://localhost:7821///", fetchFn }),
      sampleFileData,
    );
    expect(captured[0].url).toBe(
      "http://localhost:7821/v1/migrations/validate",
    );
  });
});

// ---------------------------------------------------------------------------
// Auth headers
// ---------------------------------------------------------------------------

describe("Auth headers", () => {
  test("runtime uses Authorization header by default", async () => {
    const { fetchFn, captured } = capturingFetch(200, {
      is_valid: true,
      errors: [],
      manifest: {},
    });
    await validateBundle(runtimeConfig({ fetchFn }), sampleFileData);
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-jwt");
    expect(headers["X-Session-Token"]).toBeUndefined();
  });

  test("managed uses X-Session-Token header by default", async () => {
    const { fetchFn, captured } = capturingFetch(200, {
      is_valid: true,
      errors: [],
      manifest: {},
    });
    await validateBundle(managedConfig({ fetchFn }), sampleFileData);
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["X-Session-Token"]).toBe("test-session-token");
    expect(headers["Authorization"]).toBeUndefined();
  });

  test("custom authHeaderName is respected", async () => {
    const { fetchFn, captured } = capturingFetch(200, {
      is_valid: true,
      errors: [],
      manifest: {},
    });
    await validateBundle(
      runtimeConfig({ authHeaderName: "X-Custom-Auth", fetchFn }),
      sampleFileData,
    );
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["X-Custom-Auth"]).toBe("Bearer test-jwt");
    expect(headers["Authorization"]).toBeUndefined();
  });

  test("managed request includes Vellum-Organization-Id from defaultHeaders", async () => {
    const { fetchFn, captured } = capturingFetch(200, {
      is_valid: true,
      errors: [],
      manifest: {},
    });
    await validateBundle(
      managedConfig({
        fetchFn,
        defaultHeaders: { "Vellum-Organization-Id": "org-123" },
      }),
      sampleFileData,
    );
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["Vellum-Organization-Id"]).toBe("org-123");
    // Managed auth header should still be present
    expect(headers["X-Session-Token"]).toBe("test-session-token");
  });

  test("runtime request is unchanged when no defaultHeaders provided", async () => {
    const { fetchFn, captured } = capturingFetch(200, {
      is_valid: true,
      errors: [],
      manifest: {},
    });
    await validateBundle(runtimeConfig({ fetchFn }), sampleFileData);
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-jwt");
    expect(headers["Vellum-Organization-Id"]).toBeUndefined();
  });

  test("auth header wins over same-named entry in defaultHeaders", async () => {
    const { fetchFn, captured } = capturingFetch(200, {
      is_valid: true,
      errors: [],
      manifest: {},
    });
    // defaultHeaders sets X-Session-Token, but authHeader should override it
    await validateBundle(
      managedConfig({
        fetchFn,
        defaultHeaders: { "X-Session-Token": "should-be-overridden" },
      }),
      sampleFileData,
    );
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["X-Session-Token"]).toBe("test-session-token");
  });

  test("auth header wins over case-insensitive entry in defaultHeaders", async () => {
    const managed = capturingFetch(200, {
      is_valid: true,
      errors: [],
      manifest: {},
    });

    await validateBundle(
      managedConfig({
        fetchFn: managed.fetchFn,
        defaultHeaders: { "x-session-token": "should-be-overridden" },
      }),
      sampleFileData,
    );

    const managedHeaders = managed.captured[0].init.headers as Record<
      string,
      string
    >;
    expect(managedHeaders["X-Session-Token"]).toBe("test-session-token");
    expect(managedHeaders["x-session-token"]).toBeUndefined();

    const runtime = capturingFetch(200, {
      is_valid: true,
      errors: [],
      manifest: {},
    });

    await validateBundle(
      runtimeConfig({
        fetchFn: runtime.fetchFn,
        defaultHeaders: { authorization: "should-be-overridden" },
      }),
      sampleFileData,
    );

    const runtimeHeaders = runtime.captured[0].init.headers as Record<
      string,
      string
    >;
    expect(runtimeHeaders.Authorization).toBe("Bearer test-jwt");
    expect(runtimeHeaders.authorization).toBeUndefined();
  });

  test("no auth header when authHeader is not provided", async () => {
    const { fetchFn, captured } = capturingFetch(200, {
      is_valid: true,
      errors: [],
      manifest: {},
    });
    await validateBundle(
      { baseURL: "http://localhost:7821", target: "runtime", fetchFn },
      sampleFileData,
    );
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["X-Session-Token"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateBundle
// ---------------------------------------------------------------------------

describe("validateBundle", () => {
  test("success — valid bundle returns is_valid: true with manifest", async () => {
    const responseBody: ValidateResponse = {
      is_valid: true,
      errors: [],
      manifest: {
        schema_version: "1.0",
        created_at: "2026-03-01T00:00:00Z",
        files: [{ path: "data/db/assistant.db", sha256: "abc", size: 100 }],
        manifest_sha256: "def",
      },
    };
    const config = runtimeConfig({ fetchFn: mockFetch(200, responseBody) });
    const result = await validateBundle(config, sampleFileData);
    expect(result.is_valid).toBe(true);
    if (result.is_valid) {
      expect(result.manifest.schema_version).toBe("1.0");
      expect(result.manifest.files).toHaveLength(1);
    }
  });

  test("failure — invalid bundle returns is_valid: false with errors", async () => {
    const responseBody: ValidateResponse = {
      is_valid: false,
      errors: [{ code: "INVALID_GZIP", message: "Not a valid gzip file" }],
    };
    const config = runtimeConfig({ fetchFn: mockFetch(200, responseBody) });
    const result = await validateBundle(config, sampleFileData);
    expect(result.is_valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("INVALID_GZIP");
  });

  test("HTTP error throws MigrationTransportError", async () => {
    const config = runtimeConfig({
      fetchFn: mockFetch(400, "Bad Request"),
    });
    try {
      await validateBundle(config, sampleFileData);
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationTransportError);
      const transportErr = err as MigrationTransportError;
      expect(transportErr.statusCode).toBe(400);
      expect(transportErr.responseBody).toBe("Bad Request");
    }
  });

  test("sends binary body with correct content type", async () => {
    const { fetchFn, captured } = capturingFetch(200, {
      is_valid: true,
      errors: [],
    });
    await validateBundle(runtimeConfig({ fetchFn }), sampleFileData);
    expect(captured[0].init.method).toBe("POST");
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/octet-stream");
  });
});

// ---------------------------------------------------------------------------
// exportBundle
// ---------------------------------------------------------------------------

describe("exportBundle", () => {
  test("runtime — returns binary archive with metadata", async () => {
    const archiveBytes = new ArrayBuffer(128);
    const config = runtimeConfig({
      fetchFn: mockFetch(200, archiveBytes, {
        "Content-Disposition": 'attachment; filename="export-2026.vbundle"',
        "X-Vbundle-Schema-Version": "1.0",
        "X-Vbundle-Manifest-Sha256": "abc123",
      }),
    });

    const result = await exportBundle(config, { description: "Test export" });
    expect(result.ok).toBe(true);
    const runtimeResult = result as ExportRuntimeResult;
    expect(runtimeResult.archive).toBeDefined();
    expect(runtimeResult.filename).toBe("export-2026.vbundle");
    expect(runtimeResult.schemaVersion).toBe("1.0");
    expect(runtimeResult.manifestSha256).toBe("abc123");
  });

  test("managed — returns job ID for async processing", async () => {
    const responseBody = { job_id: "job-123", status: "pending" };
    const config = managedConfig({ fetchFn: mockFetch(200, responseBody) });

    const result = await exportBundle(config);
    expect(result.ok).toBe(true);
    const managedResult = result as ExportManagedResult;
    expect(managedResult.jobId).toBe("job-123");
    expect(managedResult.status).toBe("pending");
  });

  test("sends description in JSON body when provided", async () => {
    const { fetchFn, captured } = capturingFetch(200, new ArrayBuffer(0), {
      "Content-Disposition": 'attachment; filename="test.vbundle"',
    });
    await exportBundle(runtimeConfig({ fetchFn }), {
      description: "My export",
    });
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    const body = captured[0].init.body as string;
    expect(JSON.parse(body)).toEqual({ description: "My export" });
  });

  test("HTTP error throws MigrationTransportError", async () => {
    const config = runtimeConfig({
      fetchFn: mockFetch(500, "Internal Server Error"),
    });
    try {
      await exportBundle(config);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationTransportError);
      expect((err as MigrationTransportError).statusCode).toBe(500);
    }
  });
});

// ---------------------------------------------------------------------------
// importPreflight
// ---------------------------------------------------------------------------

describe("importPreflight", () => {
  test("success — returns dry-run report", async () => {
    const responseBody: ImportPreflightResponse = {
      can_import: true,
      summary: {
        total_files: 2,
        files_to_create: 0,
        files_to_overwrite: 2,
        files_unchanged: 0,
        files_to_skip: 0,
      },
      files: [
        {
          path: "data/db/assistant.db",
          action: "overwrite",
          bundle_size: 1024,
          current_size: 512,
          bundle_sha256: "abc",
          current_sha256: "def",
        },
      ],
      conflicts: [],
      manifest: {
        schema_version: "1.0",
        created_at: "2026-03-01T00:00:00Z",
        files: [],
        manifest_sha256: "ghi",
      },
    };
    const config = runtimeConfig({ fetchFn: mockFetch(200, responseBody) });
    const result = await importPreflight(config, sampleFileData);
    expect(result.can_import).toBe(true);
    if (result.can_import) {
      expect(result.summary.total_files).toBe(2);
      expect(result.files[0].action).toBe("overwrite");
    }
  });

  test("validation failure — returns can_import: false with errors", async () => {
    const responseBody: ImportPreflightResponse = {
      can_import: false,
      validation: {
        is_valid: false,
        errors: [{ code: "INVALID_GZIP", message: "Not a gzip file" }],
      },
    };
    const config = runtimeConfig({ fetchFn: mockFetch(200, responseBody) });
    const result = await importPreflight(config, sampleFileData);
    expect(result.can_import).toBe(false);
    if (!result.can_import && "validation" in result) {
      expect(result.validation.errors).toHaveLength(1);
    }
  });

  test("HTTP error throws MigrationTransportError", async () => {
    const config = runtimeConfig({
      fetchFn: mockFetch(400, "Empty body"),
    });
    try {
      await importPreflight(config, sampleFileData);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationTransportError);
    }
  });
});

// ---------------------------------------------------------------------------
// importCommit
// ---------------------------------------------------------------------------

describe("importCommit", () => {
  test("success — returns import report", async () => {
    const responseBody: ImportCommitResponse = {
      success: true,
      summary: {
        total_files: 2,
        files_created: 0,
        files_overwritten: 2,
        files_skipped: 0,
        backups_created: 2,
      },
      files: [
        {
          path: "data/db/assistant.db",
          disk_path: "/home/.vellum/data/db/assistant.db",
          action: "overwritten",
          size: 1024,
          sha256: "abc",
          backup_path: "/home/.vellum/data/db/assistant.db.bak",
        },
      ],
      manifest: {
        schema_version: "1.0",
        created_at: "2026-03-01T00:00:00Z",
        files: [],
        manifest_sha256: "def",
      },
      warnings: [],
    };
    const config = runtimeConfig({ fetchFn: mockFetch(200, responseBody) });
    const result = await importCommit(config, sampleFileData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.summary.files_overwritten).toBe(2);
      expect(result.summary.backups_created).toBe(2);
    }
  });

  test("validation failure — returns success: false", async () => {
    const responseBody: ImportCommitResponse = {
      success: false,
      reason: "validation_failed",
      errors: [{ code: "INVALID_GZIP", message: "Not gzip" }],
    };
    const config = runtimeConfig({ fetchFn: mockFetch(200, responseBody) });
    const result = await importCommit(config, sampleFileData);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("validation_failed");
      expect(result.errors).toHaveLength(1);
    }
  });

  test("500 error throws MigrationTransportError", async () => {
    const config = runtimeConfig({
      fetchFn: mockFetch(500, "Server error"),
    });
    try {
      await importCommit(config, sampleFileData);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationTransportError);
      expect((err as MigrationTransportError).statusCode).toBe(500);
    }
  });

  test("400 error throws MigrationTransportError", async () => {
    const config = runtimeConfig({
      fetchFn: mockFetch(400, "Bad request"),
    });
    try {
      await importCommit(config, sampleFileData);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationTransportError);
      expect((err as MigrationTransportError).statusCode).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// pollExportStatus
// ---------------------------------------------------------------------------

describe("pollExportStatus", () => {
  test("returns pending status", async () => {
    const responseBody = { status: "pending", job_id: "job-1", progress: 0.5 };
    const config = managedConfig({ fetchFn: mockFetch(200, responseBody) });
    const result = await pollExportStatus(config, "job-1");
    expect(result.status).toBe("pending");
    expect(result.jobId).toBe("job-1");
    if (result.status === "pending") {
      expect(result.progress).toBe(0.5);
    }
  });

  test("returns complete status with download URL", async () => {
    const responseBody = {
      status: "complete",
      job_id: "job-2",
      download_url: "https://cdn.example.com/export.vbundle",
    };
    const config = managedConfig({ fetchFn: mockFetch(200, responseBody) });
    const result = await pollExportStatus(config, "job-2");
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.downloadUrl).toBe("https://cdn.example.com/export.vbundle");
    }
  });

  test("returns failed status with error", async () => {
    const responseBody = {
      status: "failed",
      job_id: "job-3",
      error: "Export timed out",
    };
    const config = managedConfig({ fetchFn: mockFetch(200, responseBody) });
    const result = await pollExportStatus(config, "job-3");
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBe("Export timed out");
    }
  });

  test("throws for runtime target", async () => {
    const config = runtimeConfig();
    try {
      await pollExportStatus(config, "job-1");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("only supported for managed");
    }
  });

  test("constructs correct URL with encoded job ID", async () => {
    const { fetchFn, captured } = capturingFetch(200, {
      status: "pending",
      job_id: "job/special",
    });
    const config = managedConfig({ fetchFn });
    await pollExportStatus(config, "job/special");
    expect(captured[0].url).toBe(
      "https://platform.vellum.ai/v1/migrations/export/job%2Fspecial/status/",
    );
    expect(captured[0].init.method).toBe("GET");
  });
});

// ---------------------------------------------------------------------------
// pollImportStatus
// ---------------------------------------------------------------------------

describe("pollImportStatus", () => {
  test("returns processing status", async () => {
    const responseBody = {
      status: "processing",
      job_id: "imp-1",
      progress: 0.8,
    };
    const config = managedConfig({ fetchFn: mockFetch(200, responseBody) });
    const result = await pollImportStatus(config, "imp-1");
    expect(result.status).toBe("processing");
    expect(result.jobId).toBe("imp-1");
  });

  test("returns complete status", async () => {
    const responseBody = {
      status: "complete",
      job_id: "imp-2",
      result: { files_imported: 3 },
    };
    const config = managedConfig({ fetchFn: mockFetch(200, responseBody) });
    const result = await pollImportStatus(config, "imp-2");
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.result).toEqual({ files_imported: 3 });
    }
  });

  test("throws for runtime target", async () => {
    const config = runtimeConfig();
    try {
      await pollImportStatus(config, "imp-1");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("only supported for managed");
    }
  });

  test("HTTP error throws MigrationTransportError", async () => {
    const config = managedConfig({
      fetchFn: mockFetch(404, "Not found"),
    });
    try {
      await pollImportStatus(config, "unknown-job");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationTransportError);
      expect((err as MigrationTransportError).statusCode).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// pollUntilComplete
// ---------------------------------------------------------------------------

describe("pollUntilComplete", () => {
  test("polls until complete status", async () => {
    let callCount = 0;
    const fetchFn = (async () => {
      callCount++;
      const status = callCount < 3 ? "pending" : "complete";
      return new Response(
        JSON.stringify({
          status,
          job_id: "job-poll",
          ...(status === "complete"
            ? { download_url: "https://cdn.example.com/test.vbundle" }
            : {}),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const progressCalls: JobStatusResponse[] = [];
    const result = await pollUntilComplete(
      managedConfig({ fetchFn }),
      "export",
      "job-poll",
      {
        intervalMs: 10,
        maxAttempts: 10,
        onProgress: (s) => progressCalls.push(s),
      },
    );

    expect(result.status).toBe("complete");
    expect(callCount).toBe(3);
    expect(progressCalls).toHaveLength(3);
    expect(progressCalls[0].status).toBe("pending");
    expect(progressCalls[2].status).toBe("complete");
  });

  test("returns failed status when job fails", async () => {
    let callCount = 0;
    const fetchFn = (async () => {
      callCount++;
      const status = callCount < 2 ? "processing" : "failed";
      return new Response(
        JSON.stringify({
          status,
          job_id: "job-fail",
          ...(status === "failed" ? { error: "Disk full" } : {}),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await pollUntilComplete(
      managedConfig({ fetchFn }),
      "import",
      "job-fail",
      { intervalMs: 10, maxAttempts: 10 },
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBe("Disk full");
    }
  });

  test("throws when maxAttempts exceeded", async () => {
    const fetchFn = (async () => {
      return new Response(
        JSON.stringify({ status: "pending", job_id: "job-slow" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      await pollUntilComplete(
        managedConfig({ fetchFn }),
        "export",
        "job-slow",
        { intervalMs: 10, maxAttempts: 3 },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationTransportError);
      expect((err as MigrationTransportError).message).toContain(
        "did not complete",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// MigrationTransportError
// ---------------------------------------------------------------------------

describe("MigrationTransportError", () => {
  test("exposes statusCode and responseBody for retry decisions", () => {
    const err = new MigrationTransportError(
      "test error",
      503,
      "Service Unavailable",
    );
    expect(err.name).toBe("MigrationTransportError");
    expect(err.statusCode).toBe(503);
    expect(err.responseBody).toBe("Service Unavailable");
    expect(err.message).toBe("test error");
  });

  test("is instanceof Error", () => {
    const err = new MigrationTransportError("test", 500, "");
    expect(err instanceof Error).toBe(true);
    expect(err instanceof MigrationTransportError).toBe(true);
  });

  test("retryable status codes can be detected by callers", () => {
    const retryable = [429, 502, 503, 504];
    const nonRetryable = [400, 401, 403, 404, 422];

    for (const code of retryable) {
      const err = new MigrationTransportError("test", code, "");
      expect(
        err.statusCode >= 429 ||
          (err.statusCode >= 500 && err.statusCode <= 504),
      ).toBe(true);
    }

    for (const code of nonRetryable) {
      const _err = new MigrationTransportError("test", code, "");
      expect(code >= 400 && code < 500 && code !== 429).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// State persistence / multi-step flow behavior
// ---------------------------------------------------------------------------

describe("Multi-step flow behavior", () => {
  test("validate → import-preflight → import uses consistent config", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("validate")) {
        calls.push("validate");
        return new Response(
          JSON.stringify({
            is_valid: true,
            errors: [],
            manifest: {
              schema_version: "1.0",
              created_at: "2026-01-01T00:00:00Z",
              files: [],
              manifest_sha256: "abc",
            },
          }),
          { status: 200 },
        );
      }
      if (urlStr.includes("import-preflight")) {
        calls.push("import-preflight");
        return new Response(
          JSON.stringify({
            can_import: true,
            summary: {
              total_files: 1,
              files_to_create: 1,
              files_to_overwrite: 0,
              files_unchanged: 0,
              files_to_skip: 0,
            },
            files: [],
            conflicts: [],
            manifest: {
              schema_version: "1.0",
              created_at: "2026-01-01T00:00:00Z",
              files: [],
              manifest_sha256: "abc",
            },
          }),
          { status: 200 },
        );
      }
      if (urlStr.includes("/import") && !urlStr.includes("preflight")) {
        calls.push("import");
        return new Response(
          JSON.stringify({
            success: true,
            summary: {
              total_files: 1,
              files_created: 1,
              files_overwritten: 0,
              files_skipped: 0,
              backups_created: 0,
            },
            files: [],
            manifest: {
              schema_version: "1.0",
              created_at: "2026-01-01T00:00:00Z",
              files: [],
              manifest_sha256: "abc",
            },
            warnings: [],
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    const config = runtimeConfig({ fetchFn });
    const fileData = new ArrayBuffer(8);

    // Step 1: Validate
    const validateResult = await validateBundle(config, fileData);
    expect(validateResult.is_valid).toBe(true);

    // Step 2: Preflight
    const preflightResult = await importPreflight(config, fileData);
    expect(preflightResult.can_import).toBe(true);

    // Step 3: Import
    const importResult = await importCommit(config, fileData);
    expect(importResult.success).toBe(true);

    // All three steps were called in order
    expect(calls).toEqual(["validate", "import-preflight", "import"]);
  });

  test("managed export → poll flow works end-to-end", async () => {
    let fetchCallCount = 0;
    const fetchFn = (async (url: string | URL | Request) => {
      fetchCallCount++;
      const urlStr = String(url);
      if (urlStr.includes("/export/") && urlStr.includes("/status/")) {
        // Status poll
        if (fetchCallCount <= 3) {
          return new Response(
            JSON.stringify({
              status: "processing",
              job_id: "exp-1",
              progress: fetchCallCount * 0.25,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            status: "complete",
            job_id: "exp-1",
            download_url: "https://cdn.example.com/result.vbundle",
          }),
          { status: 200 },
        );
      }
      if (urlStr.endsWith("/export/")) {
        // Initial export request
        return new Response(
          JSON.stringify({ job_id: "exp-1", status: "pending" }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    const config = managedConfig({ fetchFn });

    // Step 1: Initiate export
    const exportResult = await exportBundle(config);
    expect(exportResult.ok).toBe(true);
    const managedExport = exportResult as ExportManagedResult;
    expect(managedExport.jobId).toBe("exp-1");

    // Step 2: Poll until complete
    const finalStatus = await pollUntilComplete(
      config,
      "export",
      managedExport.jobId,
      { intervalMs: 10, maxAttempts: 10 },
    );

    expect(finalStatus.status).toBe("complete");
    if (finalStatus.status === "complete") {
      expect(finalStatus.downloadUrl).toBe(
        "https://cdn.example.com/result.vbundle",
      );
    }
  });
});
