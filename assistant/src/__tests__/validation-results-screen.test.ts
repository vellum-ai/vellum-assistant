/**
 * Tests for the validation results screen view model.
 *
 * Covers:
 * - Disabled state: screen not accessible when earlier steps incomplete
 * - Loading states: validation loading, preflight loading, idle/preparing
 * - Validation error: bundle invalid with error details
 * - Transport error: network failures for validate and preflight steps
 * - Preflight error: preflight validation failure
 * - Success state: full results with summary, files, conflicts
 * - Retry behavior: reset and re-execute on retryable errors
 * - Back navigation: return to upload-bundle step
 * - File grouping: group files by action (create/overwrite/unchanged)
 * - File size formatting: human-readable byte sizes
 * - Validation flow execution: chained validate + preflight
 * - State persistence/resume: derive correct screen state after resume
 */

import { describe, expect, test } from "bun:test";

import type {
  ImportPreflightResponse,
  TransportConfig,
  ValidateResponse,
} from "../runtime/migrations/migration-transport.js";
import type {
  MigrationWizardState,
  StepExecutorOptions,
  WizardStep,
} from "../runtime/migrations/migration-wizard.js";
import {
  completeRebindSecrets,
  createWizardState,
  deserializeWizardState,
  prepareForResume,
  selectDirection,
  serializeWizardState,
  setBundleUploaded,
} from "../runtime/migrations/migration-wizard.js";
import type {
  PreflightFileEntry,
  ValidationScreenState,
} from "../runtime/migrations/validation-results-screen.js";
import {
  deriveValidationScreenState,
  executeValidationFlow,
  formatFileSize,
  goBackToUpload,
  groupFilesByAction,
  isValidationScreenAccessible,
  retryValidationFlow,
} from "../runtime/migrations/validation-results-screen.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockFetch(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): typeof fetch {
  return (async () => {
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

function runtimeConfig(overrides?: Partial<TransportConfig>): TransportConfig {
  return {
    baseURL: "http://localhost:7821",
    target: "runtime",
    authHeader: "Bearer test-jwt",
    fetchFn: mockFetch(200, {}),
    ...overrides,
  };
}

function makeExecutorOptions(
  overrides?: Partial<StepExecutorOptions>,
): StepExecutorOptions {
  return {
    sourceConfig: runtimeConfig(),
    destConfig: runtimeConfig(),
    bundleData: new ArrayBuffer(16),
    ...overrides,
  };
}

/** Advance state to a specific step for testing. */
function advanceTo(step: WizardStep): MigrationWizardState {
  let state = createWizardState();
  const stepOrder: WizardStep[] = [
    "select-direction",
    "upload-bundle",
    "validate",
    "preflight-review",
    "transfer",
    "rebind-secrets",
    "complete",
  ];
  const targetIdx = stepOrder.indexOf(step);

  if (targetIdx >= 1) {
    state = selectDirection(state, "managed-to-self-hosted");
  }
  if (targetIdx >= 2) {
    state = setBundleUploaded(state);
  }
  if (targetIdx >= 3) {
    state = {
      ...state,
      steps: { ...state.steps, validate: { status: "success" } },
      validateResult: makeValidateSuccess(),
      currentStep: "preflight-review",
    };
  }
  if (targetIdx >= 4) {
    state = {
      ...state,
      steps: { ...state.steps, "preflight-review": { status: "success" } },
      preflightResult: makePreflightSuccess(),
      currentStep: "transfer",
    };
  }
  if (targetIdx >= 5) {
    state = {
      ...state,
      steps: { ...state.steps, transfer: { status: "success" } },
      currentStep: "rebind-secrets",
    };
  }
  if (targetIdx >= 6) {
    state = completeRebindSecrets(state);
  }

  return state;
}

function makeValidateSuccess(): ValidateResponse {
  return {
    is_valid: true,
    errors: [],
    manifest: {
      schema_version: 1,
      bundle_id: "00000000-0000-4000-8000-000000000000",
      created_at: "2026-03-01T00:00:00Z",
      assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
      origin: { mode: "self-hosted-local" },
      compatibility: {
        min_runtime_version: "0.0.0-test",
        max_runtime_version: null,
      },
      contents: [
        { path: "config.json", sha256: "abc123", size_bytes: 1024 },
        { path: "skills/test.md", sha256: "def456", size_bytes: 2048 },
      ],
      checksum: "manifest-hash",
      secrets_redacted: false,
      export_options: {
        include_logs: false,
        include_browser_state: false,
        include_memory_vectors: false,
      },
    },
  };
}

function makeValidateFailure(): ValidateResponse {
  return {
    is_valid: false,
    errors: [
      {
        code: "INVALID_SCHEMA",
        message: "Bundle schema version 0.5 is not supported",
        path: "manifest.json",
      },
      {
        code: "MISSING_FILE",
        message: "Referenced file config.json not found in archive",
      },
    ],
  };
}

function makePreflightSuccess(): ImportPreflightResponse {
  return {
    can_import: true,
    summary: {
      total_files: 5,
      files_to_create: 2,
      files_to_overwrite: 2,
      files_unchanged: 1,
      files_to_skip: 0,
    },
    files: [
      {
        path: "config.json",
        action: "overwrite",
        bundle_size: 1024,
        current_size: 800,
        bundle_sha256: "abc123",
        current_sha256: "old123",
      },
      {
        path: "skills/new-skill.md",
        action: "create",
        bundle_size: 512,
        current_size: null,
        bundle_sha256: "ghi789",
        current_sha256: null,
      },
      {
        path: "memory/index.json",
        action: "overwrite",
        bundle_size: 4096,
        current_size: 3500,
        bundle_sha256: "jkl012",
        current_sha256: "old012",
      },
      {
        path: "playbooks/default.md",
        action: "unchanged",
        bundle_size: 2048,
        current_size: 2048,
        bundle_sha256: "mno345",
        current_sha256: "mno345",
      },
      {
        path: "tools/custom.ts",
        action: "create",
        bundle_size: 768,
        current_size: null,
        bundle_sha256: "pqr678",
        current_sha256: null,
      },
    ],
    conflicts: [
      {
        code: "SIZE_MISMATCH",
        message: "config.json will increase from 800B to 1024B",
        path: "config.json",
      },
    ],
    manifest: {
      schema_version: 1,
      bundle_id: "00000000-0000-4000-8000-000000000000",
      created_at: "2026-03-01T00:00:00Z",
      assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
      origin: { mode: "self-hosted-local" },
      compatibility: {
        min_runtime_version: "0.0.0-test",
        max_runtime_version: null,
      },
      contents: [
        { path: "config.json", sha256: "abc123", size_bytes: 1024 },
        { path: "skills/new-skill.md", sha256: "ghi789", size_bytes: 512 },
      ],
      checksum: "manifest-hash",
      secrets_redacted: false,
      export_options: {
        include_logs: false,
        include_browser_state: false,
        include_memory_vectors: false,
      },
    },
  };
}

function makePreflightFailure(): ImportPreflightResponse {
  return {
    can_import: false,
    validation: {
      is_valid: false,
      errors: [
        {
          code: "INCOMPATIBLE_VERSION",
          message: "Bundle requires schema version 2.0, current is 1.0",
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Disabled state
// ---------------------------------------------------------------------------

describe("deriveValidationScreenState — disabled", () => {
  test("returns disabled when on select-direction step", () => {
    const state = createWizardState();
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("disabled");
  });

  test("returns disabled when on upload-bundle step", () => {
    const state = advanceTo("upload-bundle");
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("disabled");
  });

  test("isValidationScreenAccessible returns false for early steps", () => {
    expect(isValidationScreenAccessible(createWizardState())).toBe(false);
  });

  test("isValidationScreenAccessible returns true for validate step", () => {
    const state = advanceTo("validate");
    expect(isValidationScreenAccessible(state)).toBe(true);
  });

  test("isValidationScreenAccessible returns true for preflight-review step", () => {
    const state = advanceTo("preflight-review");
    expect(isValidationScreenAccessible(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Loading states
// ---------------------------------------------------------------------------

describe("deriveValidationScreenState — loading", () => {
  test("shows loading when validate step is idle (preparing)", () => {
    const state = advanceTo("validate");
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("loading");
    if (screen.phase === "loading") {
      expect(screen.message).toContain("validation");
    }
  });

  test("shows loading when validate step is in loading status", () => {
    let state = advanceTo("validate");
    state = {
      ...state,
      steps: { ...state.steps, validate: { status: "loading" } },
    };
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("loading");
    if (screen.phase === "loading") {
      expect(screen.message).toContain("Validating");
    }
  });

  test("shows loading when preflight-review step is idle (preparing)", () => {
    let state = advanceTo("preflight-review");
    state = {
      ...state,
      steps: { ...state.steps, "preflight-review": { status: "idle" } },
    };
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("loading");
    if (screen.phase === "loading") {
      expect(screen.message).toContain("import analysis");
    }
  });

  test("shows loading when preflight-review step is in loading status", () => {
    let state = advanceTo("preflight-review");
    state = {
      ...state,
      steps: { ...state.steps, "preflight-review": { status: "loading" } },
    };
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("loading");
    if (screen.phase === "loading") {
      expect(screen.message).toContain("Analyzing");
    }
  });
});

// ---------------------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------------------

describe("deriveValidationScreenState — validation-error", () => {
  test("shows validation-error with error details when bundle is invalid", () => {
    let state = advanceTo("validate");
    state = {
      ...state,
      steps: {
        ...state.steps,
        validate: {
          status: "error",
          error: {
            message: "Bundle validation failed",
            code: "INVALID_SCHEMA",
            retryable: true,
          },
        },
      },
      validateResult: makeValidateFailure(),
    };
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("validation-error");
    if (screen.phase === "validation-error") {
      expect(screen.errors).toHaveLength(2);
      expect(screen.errors[0].code).toBe("INVALID_SCHEMA");
      expect(screen.errors[0].message).toContain("schema version");
      expect(screen.errors[1].code).toBe("MISSING_FILE");
      expect(screen.canRetry).toBe(true);
    }
  });

  test("shows validation-error as non-retryable when error is not retryable", () => {
    let state = advanceTo("validate");
    state = {
      ...state,
      steps: {
        ...state.steps,
        validate: {
          status: "error",
          error: {
            message: "Bundle validation failed",
            code: "INVALID_SCHEMA",
            retryable: false,
          },
        },
      },
      validateResult: makeValidateFailure(),
    };
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("validation-error");
    if (screen.phase === "validation-error") {
      expect(screen.canRetry).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Transport error
// ---------------------------------------------------------------------------

describe("deriveValidationScreenState — transport-error", () => {
  test("shows transport-error for validate step network failure", () => {
    let state = advanceTo("validate");
    state = {
      ...state,
      steps: {
        ...state.steps,
        validate: {
          status: "error",
          error: {
            message: "validate: HTTP 500",
            code: "HTTP_500",
            retryable: true,
          },
        },
      },
      // No validateResult means it was a transport failure, not a validation failure
    };
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("transport-error");
    if (screen.phase === "transport-error") {
      expect(screen.step).toBe("validate");
      expect(screen.error.message).toContain("HTTP 500");
      expect(screen.canRetry).toBe(true);
    }
  });

  test("shows transport-error for preflight step network failure", () => {
    let state = advanceTo("preflight-review");
    state = {
      ...state,
      steps: {
        ...state.steps,
        "preflight-review": {
          status: "error",
          error: {
            message: "import-preflight: HTTP 503",
            code: "HTTP_503",
            retryable: true,
          },
        },
      },
    };
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("transport-error");
    if (screen.phase === "transport-error") {
      expect(screen.step).toBe("preflight-review");
      expect(screen.error.message).toContain("HTTP 503");
      expect(screen.canRetry).toBe(true);
    }
  });

  test("shows transport-error with 429 rate limit as retryable", () => {
    let state = advanceTo("validate");
    state = {
      ...state,
      steps: {
        ...state.steps,
        validate: {
          status: "error",
          error: {
            message: "validate: HTTP 429",
            code: "HTTP_429",
            retryable: true,
          },
        },
      },
    };
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("transport-error");
    if (screen.phase === "transport-error") {
      expect(screen.canRetry).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Preflight error
// ---------------------------------------------------------------------------

describe("deriveValidationScreenState — preflight-error", () => {
  test("shows preflight-error when preflight validation fails", () => {
    let state = advanceTo("preflight-review");
    state = {
      ...state,
      steps: {
        ...state.steps,
        "preflight-review": {
          status: "error",
          error: {
            message: "Import preflight validation failed",
            code: "INCOMPATIBLE_VERSION",
            retryable: true,
          },
        },
      },
      preflightResult: makePreflightFailure(),
    };
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("preflight-error");
    if (screen.phase === "preflight-error") {
      expect(screen.error.message).toContain("preflight");
      expect(screen.canRetry).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Success state
// ---------------------------------------------------------------------------

describe("deriveValidationScreenState — success", () => {
  test("shows success with full results when both steps pass", () => {
    const state = advanceTo("transfer");
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("success");
    if (screen.phase === "success") {
      expect(screen.validation.isValid).toBe(true);
      expect(screen.validation.manifest.schema_version).toBe(1);
    }
  });

  test("includes preflight summary counts", () => {
    const state = advanceTo("transfer");
    const screen = deriveValidationScreenState(state);
    if (screen.phase === "success") {
      expect(screen.preflight.summary.totalFiles).toBe(5);
      expect(screen.preflight.summary.filesToCreate).toBe(2);
      expect(screen.preflight.summary.filesToOverwrite).toBe(2);
      expect(screen.preflight.summary.filesUnchanged).toBe(1);
    }
  });

  test("includes normalized file entries", () => {
    const state = advanceTo("transfer");
    const screen = deriveValidationScreenState(state);
    if (screen.phase === "success") {
      expect(screen.preflight.files).toHaveLength(5);
      const createFile = screen.preflight.files.find(
        (f) => f.path === "skills/new-skill.md",
      );
      expect(createFile).toBeDefined();
      expect(createFile!.action).toBe("create");
      expect(createFile!.bundleSize).toBe(512);
      expect(createFile!.currentSize).toBeNull();
    }
  });

  test("includes conflict entries", () => {
    const state = advanceTo("transfer");
    const screen = deriveValidationScreenState(state);
    if (screen.phase === "success") {
      expect(screen.preflight.conflicts).toHaveLength(1);
      expect(screen.preflight.conflicts[0].code).toBe("SIZE_MISMATCH");
      expect(screen.preflight.conflicts[0].path).toBe("config.json");
    }
  });

  test("canContinue is true when transfer step is accessible", () => {
    const state = advanceTo("transfer");
    const screen = deriveValidationScreenState(state);
    if (screen.phase === "success") {
      expect(screen.canContinue).toBe(true);
    }
  });

  test("success state persists when viewing from later steps", () => {
    const state = advanceTo("rebind-secrets");
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// Retry behavior
// ---------------------------------------------------------------------------

describe("retryValidationFlow", () => {
  test("retries validate step after transport error", async () => {
    let state = advanceTo("validate");
    const validateSuccess = makeValidateSuccess();
    const preflightSuccess = makePreflightSuccess();

    // Simulate a failed validate step
    state = {
      ...state,
      steps: {
        ...state.steps,
        validate: {
          status: "error",
          error: {
            message: "validate: HTTP 500",
            code: "HTTP_500",
            retryable: true,
          },
        },
      },
    };

    // Set up sequential responses: validate success, then preflight success
    let callCount = 0;
    const sequentialFetch = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify(validateSuccess), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(preflightSuccess), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const options = makeExecutorOptions({
      destConfig: runtimeConfig({ fetchFn: sequentialFetch }),
    });

    const result = await retryValidationFlow(state, options);
    expect(result.steps["validate"].status).toBe("success");
    expect(result.currentStep).toBe("transfer");
  });

  test("retries preflight step after error", async () => {
    let state = advanceTo("preflight-review");
    const preflightSuccess = makePreflightSuccess();

    state = {
      ...state,
      steps: {
        ...state.steps,
        "preflight-review": {
          status: "error",
          error: {
            message: "import-preflight: HTTP 500",
            code: "HTTP_500",
            retryable: true,
          },
        },
      },
    };

    const options = makeExecutorOptions({
      destConfig: runtimeConfig({
        fetchFn: mockFetch(200, preflightSuccess),
      }),
    });

    const result = await retryValidationFlow(state, options);
    expect(result.steps["preflight-review"].status).toBe("success");
    expect(result.currentStep).toBe("transfer");
  });

  test("throws when trying to retry non-retryable error", () => {
    let state = advanceTo("validate");
    state = {
      ...state,
      steps: {
        ...state.steps,
        validate: {
          status: "error",
          error: {
            message: "Fatal error",
            retryable: false,
          },
        },
      },
    };

    const options = makeExecutorOptions();
    expect(retryValidationFlow(state, options)).rejects.toThrow(
      "not in a retryable error state",
    );
  });
});

// ---------------------------------------------------------------------------
// Validation flow execution
// ---------------------------------------------------------------------------

describe("executeValidationFlow", () => {
  test("runs validate and preflight in sequence on success", async () => {
    const state = advanceTo("validate");
    const validateSuccess = makeValidateSuccess();
    const preflightSuccess = makePreflightSuccess();

    let callCount = 0;
    const sequentialFetch = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify(validateSuccess), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(preflightSuccess), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const stateChanges: MigrationWizardState[] = [];
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({ fetchFn: sequentialFetch }),
      onStateChange: (s) => stateChanges.push(s),
    });

    const result = await executeValidationFlow(state, options);

    expect(result.steps["validate"].status).toBe("success");
    expect(result.steps["preflight-review"].status).toBe("success");
    expect(result.currentStep).toBe("transfer");
    expect(result.validateResult).toBeDefined();
    expect(result.preflightResult).toBeDefined();

    // State changes should include loading states
    const loadingStates = stateChanges.filter(
      (s) =>
        s.steps["validate"].status === "loading" ||
        s.steps["preflight-review"].status === "loading",
    );
    expect(loadingStates.length).toBeGreaterThan(0);
  });

  test("stops at validate when validation fails", async () => {
    const state = advanceTo("validate");
    const validateFailure = makeValidateFailure();

    const options = makeExecutorOptions({
      destConfig: runtimeConfig({
        fetchFn: mockFetch(200, validateFailure),
      }),
    });

    const result = await executeValidationFlow(state, options);

    expect(result.steps["validate"].status).toBe("error");
    expect(result.currentStep).toBe("validate");
    expect(result.validateResult).toEqual(validateFailure);

    const screen = deriveValidationScreenState(result);
    expect(screen.phase).toBe("validation-error");
  });

  test("stops at validate on transport error", async () => {
    const state = advanceTo("validate");

    const options = makeExecutorOptions({
      destConfig: runtimeConfig({
        fetchFn: mockFetch(500, "Internal server error"),
      }),
    });

    const result = await executeValidationFlow(state, options);

    expect(result.steps["validate"].status).toBe("error");
    expect(result.currentStep).toBe("validate");

    const screen = deriveValidationScreenState(result);
    expect(screen.phase).toBe("transport-error");
  });
});

// ---------------------------------------------------------------------------
// Back navigation
// ---------------------------------------------------------------------------

describe("goBackToUpload", () => {
  test("navigates back to upload-bundle from validate", () => {
    const state = advanceTo("validate");
    const result = goBackToUpload(state);
    expect(result.currentStep).toBe("upload-bundle");
    expect(result.steps["validate"].status).toBe("idle");
  });

  test("navigates back to upload-bundle from preflight-review", () => {
    const state = advanceTo("preflight-review");
    const result = goBackToUpload(state);
    expect(result.currentStep).toBe("upload-bundle");
    expect(result.steps["validate"].status).toBe("idle");
    expect(result.steps["preflight-review"].status).toBe("idle");
  });

  test("clears validation and preflight results when going back", () => {
    let state = advanceTo("preflight-review");
    state = {
      ...state,
      validateResult: makeValidateSuccess(),
      preflightResult: makePreflightSuccess(),
    };
    const result = goBackToUpload(state);
    expect(result.validateResult).toBeUndefined();
    expect(result.preflightResult).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// File grouping
// ---------------------------------------------------------------------------

describe("groupFilesByAction", () => {
  test("groups files by action type", () => {
    const files: PreflightFileEntry[] = [
      {
        path: "a.txt",
        action: "create",
        bundleSize: 100,
        currentSize: null,
        bundleSha256: "a",
        currentSha256: null,
      },
      {
        path: "b.txt",
        action: "overwrite",
        bundleSize: 200,
        currentSize: 150,
        bundleSha256: "b",
        currentSha256: "b-old",
      },
      {
        path: "c.txt",
        action: "unchanged",
        bundleSize: 300,
        currentSize: 300,
        bundleSha256: "c",
        currentSha256: "c",
      },
      {
        path: "d.txt",
        action: "create",
        bundleSize: 400,
        currentSize: null,
        bundleSha256: "d",
        currentSha256: null,
      },
    ];

    const grouped = groupFilesByAction(files);
    expect(grouped.create).toHaveLength(2);
    expect(grouped.overwrite).toHaveLength(1);
    expect(grouped.unchanged).toHaveLength(1);
    expect(grouped.create[0].path).toBe("a.txt");
    expect(grouped.create[1].path).toBe("d.txt");
    expect(grouped.overwrite[0].path).toBe("b.txt");
    expect(grouped.unchanged[0].path).toBe("c.txt");
  });

  test("handles empty file list", () => {
    const grouped = groupFilesByAction([]);
    expect(grouped.create).toHaveLength(0);
    expect(grouped.overwrite).toHaveLength(0);
    expect(grouped.unchanged).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// File size formatting
// ---------------------------------------------------------------------------

describe("formatFileSize", () => {
  test("formats bytes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(100)).toBe("100 B");
    expect(formatFileSize(1023)).toBe("1023 B");
  });

  test("formats kilobytes", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(10240)).toBe("10.0 KB");
  });

  test("formats megabytes", () => {
    expect(formatFileSize(1048576)).toBe("1.0 MB");
    expect(formatFileSize(5242880)).toBe("5.0 MB");
  });

  test("formats gigabytes", () => {
    expect(formatFileSize(1073741824)).toBe("1.0 GB");
  });
});

// ---------------------------------------------------------------------------
// State persistence and resume
// ---------------------------------------------------------------------------

describe("validation screen state persistence/resume", () => {
  test("derives correct state after serialize + deserialize at validate step", () => {
    const state = advanceTo("validate");
    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    // After deserialization, hasBundleData is false, so prepareForResume
    // should redirect to upload-bundle
    const resumed = prepareForResume(restored!);
    const screen = deriveValidationScreenState(resumed);
    // After resume without bundle data, goes back to upload-bundle
    expect(screen.phase).toBe("disabled");
    expect(resumed.currentStep).toBe("upload-bundle");
  });

  test("derives correct state after resume at preflight-review step with loading status", () => {
    let state = advanceTo("preflight-review");
    state = {
      ...state,
      steps: { ...state.steps, "preflight-review": { status: "loading" } },
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    // prepareForResume resets loading to idle and redirects to upload-bundle
    // because hasBundleData is false after deserialization
    const resumed = prepareForResume(restored!);
    expect(resumed.currentStep).toBe("upload-bundle");
  });

  test("success results persist across serialize/deserialize", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      validateResult: makeValidateSuccess(),
      preflightResult: makePreflightSuccess(),
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    const screen = deriveValidationScreenState(restored!);
    expect(screen.phase).toBe("success");
    if (screen.phase === "success") {
      expect(screen.preflight.summary.totalFiles).toBe(5);
    }
  });

  test("error state is preserved after serialize/deserialize", () => {
    let state = advanceTo("validate");
    state = {
      ...state,
      steps: {
        ...state.steps,
        validate: {
          status: "error",
          error: {
            message: "Bundle validation failed",
            code: "INVALID_SCHEMA",
            retryable: true,
          },
        },
      },
      validateResult: makeValidateFailure(),
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    // After deserialization, hasBundleData is false. prepareForResume
    // will redirect to upload-bundle since bundle data is needed.
    // But the raw deserialized state (before resume) preserves the error.
    const screen = deriveValidationScreenState(restored!);
    expect(screen.phase).toBe("validation-error");
    if (screen.phase === "validation-error") {
      expect(screen.errors).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// State change callbacks
// ---------------------------------------------------------------------------

describe("executeValidationFlow — onStateChange callbacks", () => {
  test("emits state changes during validation flow", async () => {
    const state = advanceTo("validate");
    const validateSuccess = makeValidateSuccess();
    const preflightSuccess = makePreflightSuccess();

    let callCount = 0;
    const sequentialFetch = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify(validateSuccess), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(preflightSuccess), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const stateChanges: ValidationScreenState[] = [];
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({ fetchFn: sequentialFetch }),
      onStateChange: (s) => stateChanges.push(deriveValidationScreenState(s)),
    });

    await executeValidationFlow(state, options);

    // Should have gone through loading states
    const phases = stateChanges.map((s) => s.phase);
    expect(phases).toContain("loading");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("validation screen edge cases", () => {
  test("handles validate error without validateResult gracefully", () => {
    let state = advanceTo("validate");
    state = {
      ...state,
      steps: {
        ...state.steps,
        validate: {
          status: "error",
          error: {
            message: "Network timeout",
            retryable: true,
          },
        },
      },
      // No validateResult — pure transport error
    };
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("transport-error");
    if (screen.phase === "transport-error") {
      expect(screen.error.message).toBe("Network timeout");
    }
  });

  test("handles preflight error without preflightResult gracefully", () => {
    let state = advanceTo("preflight-review");
    state = {
      ...state,
      steps: {
        ...state.steps,
        "preflight-review": {
          status: "error",
          error: {
            message: "Connection refused",
            retryable: true,
          },
        },
      },
      // No preflightResult — pure transport error
    };
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("transport-error");
    if (screen.phase === "transport-error") {
      expect(screen.error.message).toBe("Connection refused");
    }
  });

  test("handles validate step with error but no error details", () => {
    let state = advanceTo("validate");
    state = {
      ...state,
      steps: {
        ...state.steps,
        validate: { status: "error" },
      },
    };
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("transport-error");
    if (screen.phase === "transport-error") {
      expect(screen.error.message).toBe("Validation failed");
    }
  });

  test("handles complete wizard state — success still visible", () => {
    const state = advanceTo("complete");
    const screen = deriveValidationScreenState(state);
    expect(screen.phase).toBe("success");
  });
});
