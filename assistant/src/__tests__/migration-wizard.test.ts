/**
 * Tests for the migration wizard state machine.
 *
 * Covers:
 * - State creation and initial values
 * - Direction selection (both directions)
 * - Step transitions: forward, backward, skip prevention
 * - Step status tracking: idle, loading, success, error
 * - Validate step execution: success, validation failure, transport error
 * - Preflight step execution: success, validation failure, transport error
 * - Transfer step execution: runtime export+import, managed export+poll+import
 * - Rebind-secrets completion
 * - Error handling: retryable vs non-retryable, retry reset
 * - Persistence: serialize, deserialize, resume, corrupted data
 * - Query helpers: step order, accessibility, completion
 * - Full wizard flow end-to-end
 */

import { describe, expect, test } from "bun:test";

import type {
  ImportCommitResponse,
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
  canRetryCurrentStep,
  completeRebindSecrets,
  createWizardState,
  deserializeWizardState,
  executePreflightStep,
  executeTransferStep,
  executeValidateStep,
  getCurrentStepIndex,
  getStepOrder,
  getTotalSteps,
  goBackTo,
  isResumable,
  isStepAccessible,
  isWizardComplete,
  prepareForResume,
  resetStepForRetry,
  selectDirection,
  serializeWizardState,
  setBundleUploaded,
  validateWizardTransition,
} from "../runtime/migrations/migration-wizard.js";

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

function managedConfig(overrides?: Partial<TransportConfig>): TransportConfig {
  return {
    baseURL: "https://platform.vellum.ai",
    target: "managed",
    authHeader: "test-session-token",
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
      currentStep: "preflight-review",
    };
  }
  if (targetIdx >= 4) {
    state = {
      ...state,
      steps: { ...state.steps, "preflight-review": { status: "success" } },
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

// ---------------------------------------------------------------------------
// State creation
// ---------------------------------------------------------------------------

describe("createWizardState", () => {
  test("creates initial state with select-direction as first step", () => {
    const state = createWizardState();
    expect(state.currentStep).toBe("select-direction");
    expect(state.direction).toBeUndefined();
    expect(state.hasBundleData).toBe(false);
  });

  test("all steps start as idle", () => {
    const state = createWizardState();
    const allSteps: WizardStep[] = [
      "select-direction",
      "upload-bundle",
      "validate",
      "preflight-review",
      "transfer",
      "rebind-secrets",
      "complete",
    ];
    for (const step of allSteps) {
      expect(state.steps[step].status).toBe("idle");
      expect(state.steps[step].error).toBeUndefined();
    }
  });

  test("sets timestamps", () => {
    const before = new Date().toISOString();
    const state = createWizardState();
    const after = new Date().toISOString();
    expect(state.createdAt >= before).toBe(true);
    expect(state.createdAt <= after).toBe(true);
    expect(state.updatedAt).toBe(state.createdAt);
  });

  test("no results are set initially", () => {
    const state = createWizardState();
    expect(state.validateResult).toBeUndefined();
    expect(state.preflightResult).toBeUndefined();
    expect(state.exportResult).toBeUndefined();
    expect(state.importResult).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Direction selection
// ---------------------------------------------------------------------------

describe("selectDirection", () => {
  test("managed-to-self-hosted direction advances to upload-bundle", () => {
    const state = createWizardState();
    const next = selectDirection(state, "managed-to-self-hosted");
    expect(next.direction).toBe("managed-to-self-hosted");
    expect(next.currentStep).toBe("upload-bundle");
    expect(next.steps["select-direction"].status).toBe("success");
  });

  test("self-hosted-to-managed direction advances to upload-bundle", () => {
    const state = createWizardState();
    const next = selectDirection(state, "self-hosted-to-managed");
    expect(next.direction).toBe("self-hosted-to-managed");
    expect(next.currentStep).toBe("upload-bundle");
    expect(next.steps["select-direction"].status).toBe("success");
  });

  test("throws when called from wrong step", () => {
    const state = advanceTo("validate");
    expect(() => selectDirection(state, "managed-to-self-hosted")).toThrow(
      "wrong step",
    );
  });
});

// ---------------------------------------------------------------------------
// Bundle upload
// ---------------------------------------------------------------------------

describe("setBundleUploaded", () => {
  test("advances to validate step", () => {
    const state = advanceTo("upload-bundle");
    const next = setBundleUploaded(state);
    expect(next.currentStep).toBe("validate");
    expect(next.hasBundleData).toBe(true);
    expect(next.steps["upload-bundle"].status).toBe("success");
  });

  test("throws when called from wrong step", () => {
    const state = advanceTo("validate");
    expect(() => setBundleUploaded(state)).toThrow("wrong step");
  });
});

// ---------------------------------------------------------------------------
// Transition validation
// ---------------------------------------------------------------------------

describe("validateWizardTransition", () => {
  test("same-step transition is always valid", () => {
    const state = advanceTo("validate");
    expect(validateWizardTransition(state, "validate").valid).toBe(true);
  });

  test("forward transition requires current step to be in success", () => {
    let state = advanceTo("validate");
    // validate is currently idle
    const result = validateWizardTransition(state, "preflight-review");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("idle");

    // Set validate to success
    state = {
      ...state,
      steps: { ...state.steps, validate: { status: "success" } },
    };
    expect(validateWizardTransition(state, "preflight-review").valid).toBe(
      true,
    );
  });

  test("cannot skip steps forward", () => {
    const state = advanceTo("validate");
    const result = validateWizardTransition(state, "transfer");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("skip");
  });

  test("backward transition is always allowed", () => {
    const state = advanceTo("transfer");
    expect(validateWizardTransition(state, "select-direction").valid).toBe(
      true,
    );
    expect(validateWizardTransition(state, "upload-bundle").valid).toBe(true);
    expect(validateWizardTransition(state, "validate").valid).toBe(true);
  });

  test("cannot transition from complete", () => {
    const state = advanceTo("complete");
    const result = validateWizardTransition(state, "select-direction");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("terminal");
  });
});

// ---------------------------------------------------------------------------
// goBackTo
// ---------------------------------------------------------------------------

describe("goBackTo", () => {
  test("going back resets target and subsequent steps to idle", () => {
    const state = advanceTo("transfer");
    const backed = goBackTo(state, "upload-bundle");
    expect(backed.currentStep).toBe("upload-bundle");
    // Target step is reset
    expect(backed.steps["upload-bundle"].status).toBe("idle");
    // Steps after target are reset
    expect(backed.steps["validate"].status).toBe("idle");
    expect(backed.steps["preflight-review"].status).toBe("idle");
    expect(backed.steps["transfer"].status).toBe("idle");
    // Earlier steps retain their status
    expect(backed.steps["select-direction"].status).toBe("success");
  });

  test("going back clears results for reset steps", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      validateResult: { is_valid: true, errors: [], manifest: {} as never },
    };
    state = { ...state, preflightResult: { can_import: true } as never };
    const backed = goBackTo(state, "upload-bundle");
    expect(backed.validateResult).toBeUndefined();
    expect(backed.preflightResult).toBeUndefined();
  });

  test("throws for invalid back-navigation", () => {
    const state = advanceTo("complete");
    expect(() => goBackTo(state, "select-direction")).toThrow(
      "Invalid back-navigation",
    );
  });
});

// ---------------------------------------------------------------------------
// executeValidateStep
// ---------------------------------------------------------------------------

describe("executeValidateStep", () => {
  test("success — sets status to success and advances to preflight-review", async () => {
    const validateResponse: ValidateResponse = {
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
          { path: "data/db/assistant.db", sha256: "abc", size_bytes: 100 },
        ],
        checksum: "def",
        secrets_redacted: false,
        export_options: {
          include_logs: false,
          include_browser_state: false,
          include_memory_vectors: false,
        },
      },
    };

    const state = advanceTo("validate");
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({ fetchFn: mockFetch(200, validateResponse) }),
    });

    const result = await executeValidateStep(state, options);
    expect(result.steps.validate.status).toBe("success");
    expect(result.currentStep).toBe("preflight-review");
    expect(result.validateResult).toBeDefined();
    if (result.validateResult && result.validateResult.is_valid) {
      expect(result.validateResult.manifest.schema_version).toBe(1);
    }
  });

  test("validation failure — sets status to error with retryable flag", async () => {
    const validateResponse: ValidateResponse = {
      is_valid: false,
      errors: [{ code: "INVALID_GZIP", message: "Not a valid gzip file" }],
    };

    const state = advanceTo("validate");
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({ fetchFn: mockFetch(200, validateResponse) }),
    });

    const result = await executeValidateStep(state, options);
    expect(result.steps.validate.status).toBe("error");
    expect(result.steps.validate.error?.retryable).toBe(true);
    expect(result.steps.validate.error?.message).toContain(
      "Not a valid gzip file",
    );
    expect(result.currentStep).toBe("validate"); // Does not advance
  });

  test("transport error — maps HTTP error to step error", async () => {
    const state = advanceTo("validate");
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({
        fetchFn: mockFetch(500, "Internal Server Error"),
      }),
    });

    const result = await executeValidateStep(state, options);
    expect(result.steps.validate.status).toBe("error");
    expect(result.steps.validate.error?.code).toBe("HTTP_500");
    expect(result.steps.validate.error?.retryable).toBe(true);
  });

  test("non-retryable error — 400 is not retryable", async () => {
    const state = advanceTo("validate");
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({ fetchFn: mockFetch(400, "Bad Request") }),
    });

    const result = await executeValidateStep(state, options);
    expect(result.steps.validate.status).toBe("error");
    expect(result.steps.validate.error?.retryable).toBe(false);
  });

  test("429 rate limit error is retryable", async () => {
    const state = advanceTo("validate");
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({ fetchFn: mockFetch(429, "Rate Limited") }),
    });

    const result = await executeValidateStep(state, options);
    expect(result.steps.validate.status).toBe("error");
    expect(result.steps.validate.error?.retryable).toBe(true);
    expect(result.steps.validate.error?.code).toBe("HTTP_429");
  });

  test("loading state is set before async operation", async () => {
    const stateChanges: MigrationWizardState[] = [];
    const state = advanceTo("validate");
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({
        fetchFn: mockFetch(200, { is_valid: true, errors: [], manifest: {} }),
      }),
      onStateChange: (s) => stateChanges.push(s),
    });

    await executeValidateStep(state, options);
    expect(stateChanges.length).toBeGreaterThanOrEqual(2);
    expect(stateChanges[0].steps.validate.status).toBe("loading");
  });

  test("throws when called from wrong step", async () => {
    const state = advanceTo("upload-bundle");
    const options = makeExecutorOptions();
    try {
      await executeValidateStep(state, options);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("wrong step");
    }
  });
});

// ---------------------------------------------------------------------------
// executePreflightStep
// ---------------------------------------------------------------------------

describe("executePreflightStep", () => {
  test("success — sets status to success and advances to transfer", async () => {
    const preflightResponse: ImportPreflightResponse = {
      can_import: true,
      summary: {
        total_files: 2,
        files_to_create: 1,
        files_to_overwrite: 1,
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
        schema_version: 1,
        bundle_id: "00000000-0000-4000-8000-000000000000",
        created_at: "2026-03-01T00:00:00Z",
        assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
        origin: { mode: "self-hosted-local" },
        compatibility: {
          min_runtime_version: "0.0.0-test",
          max_runtime_version: null,
        },
        contents: [],
        checksum: "ghi",
        secrets_redacted: false,
        export_options: {
          include_logs: false,
          include_browser_state: false,
          include_memory_vectors: false,
        },
      },
    };

    const state = advanceTo("preflight-review");
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({ fetchFn: mockFetch(200, preflightResponse) }),
    });

    const result = await executePreflightStep(state, options);
    expect(result.steps["preflight-review"].status).toBe("success");
    expect(result.currentStep).toBe("transfer");
    expect(result.preflightResult).toBeDefined();
  });

  test("validation failure — sets error state", async () => {
    const preflightResponse: ImportPreflightResponse = {
      can_import: false,
      validation: {
        is_valid: false,
        errors: [{ code: "SCHEMA_MISMATCH", message: "Incompatible schema" }],
      },
    };

    const state = advanceTo("preflight-review");
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({ fetchFn: mockFetch(200, preflightResponse) }),
    });

    const result = await executePreflightStep(state, options);
    expect(result.steps["preflight-review"].status).toBe("error");
    expect(result.steps["preflight-review"].error?.retryable).toBe(true);
    expect(result.currentStep).toBe("preflight-review");
  });

  test("transport error is handled", async () => {
    const state = advanceTo("preflight-review");
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({
        fetchFn: mockFetch(503, "Service Unavailable"),
      }),
    });

    const result = await executePreflightStep(state, options);
    expect(result.steps["preflight-review"].status).toBe("error");
    expect(result.steps["preflight-review"].error?.retryable).toBe(true);
  });

  test("throws when called from wrong step", async () => {
    const state = advanceTo("validate");
    const options = makeExecutorOptions();
    try {
      await executePreflightStep(state, options);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("wrong step");
    }
  });
});

// ---------------------------------------------------------------------------
// executeTransferStep
// ---------------------------------------------------------------------------

describe("executeTransferStep", () => {
  test("import-only — success", async () => {
    const importResponse: ImportCommitResponse = {
      success: true,
      summary: {
        total_files: 1,
        files_created: 1,
        files_overwritten: 0,
        files_skipped: 0,
        backups_created: 0,
      },
      files: [
        {
          path: "data/db/assistant.db",
          disk_path: "/home/.vellum/data/db/assistant.db",
          action: "created",
          size: 64,
          sha256: "xyz",
          backup_path: null,
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
        contents: [],
        checksum: "abc",
        secrets_redacted: false,
        export_options: {
          include_logs: false,
          include_browser_state: false,
          include_memory_vectors: false,
        },
      },
      warnings: [],
    };

    let importCalled = false;

    const destFetch = (async () => {
      importCalled = true;
      return new Response(JSON.stringify(importResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const state = advanceTo("transfer");
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({ fetchFn: destFetch }),
    });

    const result = await executeTransferStep(state, options);
    expect(importCalled).toBe(true);
    expect(result.steps.transfer.status).toBe("success");
    expect(result.currentStep).toBe("rebind-secrets");
    expect(result.importResult).toBeDefined();
    if (result.importResult && result.importResult.success) {
      expect(result.importResult.summary.files_created).toBe(1);
    }
  });

  test("managed export + poll + import — success", async () => {
    let fetchCallCount = 0;
    const importResponse: ImportCommitResponse = {
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
        schema_version: 1,
        bundle_id: "00000000-0000-4000-8000-000000000000",
        created_at: "2026-03-01T00:00:00Z",
        assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
        origin: { mode: "self-hosted-local" },
        compatibility: {
          min_runtime_version: "0.0.0-test",
          max_runtime_version: null,
        },
        contents: [],
        checksum: "abc",
        secrets_redacted: false,
        export_options: {
          include_logs: false,
          include_browser_state: false,
          include_memory_vectors: false,
        },
      },
      warnings: [],
    };

    const sourceFetch = (async (url: string | URL | Request) => {
      fetchCallCount++;
      const urlStr = String(url);
      if (urlStr.endsWith("/export/")) {
        return new Response(
          JSON.stringify({ job_id: "exp-1", status: "pending" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (urlStr.includes("/export/") && urlStr.includes("/status/")) {
        if (fetchCallCount <= 3) {
          return new Response(
            JSON.stringify({ status: "processing", job_id: "exp-1" }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({
            status: "complete",
            job_id: "exp-1",
            download_url: "https://cdn.example.com/export.vbundle",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (urlStr === "https://cdn.example.com/export.vbundle") {
        return new Response(new ArrayBuffer(32), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    const destFetch = (async () => {
      return new Response(JSON.stringify(importResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const state = advanceTo("transfer");
    const options = makeExecutorOptions({
      sourceConfig: managedConfig({ fetchFn: sourceFetch }),
      destConfig: runtimeConfig({ fetchFn: destFetch }),
    });

    const result = await executeTransferStep(state, options);
    expect(result.steps.transfer.status).toBe("success");
    expect(result.currentStep).toBe("rebind-secrets");
  });

  test("export failure — sets error", async () => {
    const state = advanceTo("transfer");
    const options = makeExecutorOptions({
      sourceConfig: runtimeConfig({ fetchFn: mockFetch(500, "Server Error") }),
    });

    const result = await executeTransferStep(state, options);
    expect(result.steps.transfer.status).toBe("error");
    expect(result.steps.transfer.error?.retryable).toBe(true);
  });

  test("import failure — sets error with reason", async () => {
    const archiveBytes = new ArrayBuffer(32);
    const importResponse: ImportCommitResponse = {
      success: false,
      reason: "write_failed",
      message: "Disk full",
    };

    const sourceFetch = (async () => {
      return new Response(archiveBytes, {
        status: 200,
        headers: {
          "Content-Disposition": 'attachment; filename="export.vbundle"',
          "X-Vbundle-Schema-Version": "1",
          "X-Vbundle-Manifest-Sha256": "abc",
        },
      });
    }) as unknown as typeof fetch;

    const destFetch = (async () => {
      return new Response(JSON.stringify(importResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const state = advanceTo("transfer");
    const options = makeExecutorOptions({
      sourceConfig: runtimeConfig({ fetchFn: sourceFetch }),
      destConfig: runtimeConfig({ fetchFn: destFetch }),
    });

    const result = await executeTransferStep(state, options);
    expect(result.steps.transfer.status).toBe("error");
    expect(result.steps.transfer.error?.message).toContain("Disk full");
    expect(result.steps.transfer.error?.retryable).toBe(true);
  });

  test("import failure — sets error with validation_failed reason", async () => {
    const failResponse: ImportCommitResponse = {
      success: false,
      reason: "validation_failed",
      message: "Manifest SHA mismatch",
    };

    const destFetch = (async () => {
      return new Response(JSON.stringify(failResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const state = advanceTo("transfer");
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({ fetchFn: destFetch }),
    });

    const result = await executeTransferStep(state, options);
    expect(result.steps.transfer.status).toBe("error");
    expect(result.steps.transfer.error?.code).toBe("validation_failed");
    expect(result.steps.transfer.error?.retryable).toBe(true);
  });

  test("throws when called from wrong step", async () => {
    const state = advanceTo("validate");
    const options = makeExecutorOptions();
    try {
      await executeTransferStep(state, options);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("wrong step");
    }
  });
});

// ---------------------------------------------------------------------------
// completeRebindSecrets
// ---------------------------------------------------------------------------

describe("completeRebindSecrets", () => {
  test("advances to complete", () => {
    const state = advanceTo("rebind-secrets");
    const result = completeRebindSecrets(state);
    expect(result.currentStep).toBe("complete");
    expect(result.steps["rebind-secrets"].status).toBe("success");
    expect(result.steps.complete.status).toBe("success");
  });

  test("throws when called from wrong step", () => {
    const state = advanceTo("transfer");
    expect(() => completeRebindSecrets(state)).toThrow("wrong step");
  });
});

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

describe("retry", () => {
  test("canRetryCurrentStep returns true for retryable errors", () => {
    let state = advanceTo("validate");
    state = {
      ...state,
      steps: {
        ...state.steps,
        validate: {
          status: "error",
          error: { message: "Server error", code: "HTTP_500", retryable: true },
        },
      },
    };
    expect(canRetryCurrentStep(state)).toBe(true);
  });

  test("canRetryCurrentStep returns false for non-retryable errors", () => {
    let state = advanceTo("validate");
    state = {
      ...state,
      steps: {
        ...state.steps,
        validate: {
          status: "error",
          error: { message: "Bad request", code: "HTTP_400", retryable: false },
        },
      },
    };
    expect(canRetryCurrentStep(state)).toBe(false);
  });

  test("canRetryCurrentStep returns false for non-error states", () => {
    const state = advanceTo("validate");
    expect(canRetryCurrentStep(state)).toBe(false);
  });

  test("resetStepForRetry sets step back to idle", () => {
    let state = advanceTo("validate");
    state = {
      ...state,
      steps: {
        ...state.steps,
        validate: {
          status: "error",
          error: { message: "Server error", retryable: true },
        },
      },
    };
    const reset = resetStepForRetry(state);
    expect(reset.steps.validate.status).toBe("idle");
    expect(reset.steps.validate.error).toBeUndefined();
  });

  test("resetStepForRetry throws for non-retryable step", () => {
    const state = advanceTo("validate");
    expect(() => resetStepForRetry(state)).toThrow(
      "not in a retryable error state",
    );
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("persistence", () => {
  describe("serializeWizardState", () => {
    test("produces valid JSON", () => {
      const state = advanceTo("validate");
      const json = serializeWizardState(state);
      const parsed = JSON.parse(json);
      expect(parsed.currentStep).toBe("validate");
      expect(parsed.direction).toBe("managed-to-self-hosted");
    });

    test("round-trips through serialize/deserialize", () => {
      const state = advanceTo("transfer");
      const json = serializeWizardState(state);
      const restored = deserializeWizardState(json);
      expect(restored).toBeDefined();
      expect(restored!.currentStep).toBe("transfer");
      expect(restored!.direction).toBe("managed-to-self-hosted");
      expect(restored!.steps["select-direction"].status).toBe("success");
    });
  });

  describe("deserializeWizardState", () => {
    test("returns undefined for invalid JSON", () => {
      expect(deserializeWizardState("not json")).toBeUndefined();
    });

    test("returns undefined for missing required fields", () => {
      expect(deserializeWizardState("{}")).toBeUndefined();
      expect(
        deserializeWizardState('{"currentStep":"validate"}'),
      ).toBeUndefined();
    });

    test("returns undefined for unknown step", () => {
      const state = createWizardState();
      const json = serializeWizardState(state);
      const modified = JSON.parse(json);
      modified.currentStep = "unknown-step";
      expect(deserializeWizardState(JSON.stringify(modified))).toBeUndefined();
    });

    test("returns undefined when a step is missing from steps record", () => {
      const state = createWizardState();
      const json = serializeWizardState(state);
      const modified = JSON.parse(json);
      delete modified.steps["validate"];
      expect(deserializeWizardState(JSON.stringify(modified))).toBeUndefined();
    });

    test("clears hasBundleData on deserialization", () => {
      let state = advanceTo("validate");
      state = { ...state, hasBundleData: true };
      const json = serializeWizardState(state);
      const restored = deserializeWizardState(json);
      expect(restored!.hasBundleData).toBe(false);
    });
  });

  describe("isResumable", () => {
    test("not resumable on first step", () => {
      const state = createWizardState();
      expect(isResumable(state)).toBe(false);
    });

    test("not resumable without direction", () => {
      const state = createWizardState();
      expect(isResumable(state)).toBe(false);
    });

    test("not resumable when complete", () => {
      const state = advanceTo("complete");
      expect(isResumable(state)).toBe(false);
    });

    test("resumable at validate step with direction set", () => {
      const state = advanceTo("validate");
      expect(isResumable(state)).toBe(true);
    });

    test("resumable at transfer step", () => {
      const state = advanceTo("transfer");
      expect(isResumable(state)).toBe(true);
    });
  });

  describe("prepareForResume", () => {
    test("resets loading step to idle", () => {
      let state = advanceTo("validate");
      state = {
        ...state,
        steps: { ...state.steps, validate: { status: "loading" } },
      };
      const prepared = prepareForResume(state);
      expect(prepared.steps.validate.status).toBe("idle");
    });

    test("goes back to upload-bundle when bundle data is missing", () => {
      let state = advanceTo("validate");
      state = { ...state, hasBundleData: false };
      const prepared = prepareForResume(state);
      expect(prepared.currentStep).toBe("upload-bundle");
      expect(prepared.steps["upload-bundle"].status).toBe("idle");
    });

    test("preserves step when bundle data is available", () => {
      let state = advanceTo("validate");
      state = { ...state, hasBundleData: true };
      const prepared = prepareForResume(state);
      expect(prepared.currentStep).toBe("validate");
    });

    test("does not change error steps", () => {
      let state = advanceTo("validate");
      state = {
        ...state,
        hasBundleData: true,
        steps: {
          ...state.steps,
          validate: {
            status: "error",
            error: { message: "Failed", retryable: true },
          },
        },
      };
      const prepared = prepareForResume(state);
      expect(prepared.steps.validate.status).toBe("error");
      expect(prepared.currentStep).toBe("validate");
    });
  });
});

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

describe("query helpers", () => {
  test("getStepOrder returns all steps", () => {
    const state = advanceTo("validate");
    const order = getStepOrder(state);
    expect(order).toHaveLength(7);
    expect(order[0]).toBe("select-direction");
    expect(order[6]).toBe("complete");
  });

  test("getCurrentStepIndex returns correct index", () => {
    expect(getCurrentStepIndex(createWizardState())).toBe(0);
    expect(getCurrentStepIndex(advanceTo("validate"))).toBe(2);
    expect(getCurrentStepIndex(advanceTo("transfer"))).toBe(4);
    expect(getCurrentStepIndex(advanceTo("complete"))).toBe(6);
  });

  test("getTotalSteps returns 7", () => {
    expect(getTotalSteps()).toBe(7);
  });

  test("isStepAccessible checks transition validity", () => {
    const state = advanceTo("validate");
    expect(isStepAccessible(state, "select-direction")).toBe(true);
    expect(isStepAccessible(state, "upload-bundle")).toBe(true);
    expect(isStepAccessible(state, "validate")).toBe(true);
    // Cannot advance because validate is not success
    expect(isStepAccessible(state, "preflight-review")).toBe(false);
    expect(isStepAccessible(state, "transfer")).toBe(false);
  });

  test("isWizardComplete returns true only when complete", () => {
    expect(isWizardComplete(createWizardState())).toBe(false);
    expect(isWizardComplete(advanceTo("validate"))).toBe(false);
    expect(isWizardComplete(advanceTo("complete"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full flow end-to-end
// ---------------------------------------------------------------------------

describe("full wizard flow", () => {
  test("managed-to-self-hosted: select → upload → validate → preflight → transfer → rebind → complete", async () => {
    // Step 1: Select direction
    let state = createWizardState();
    state = selectDirection(state, "managed-to-self-hosted");
    expect(state.currentStep).toBe("upload-bundle");

    // Step 2: Upload bundle
    state = setBundleUploaded(state);
    expect(state.currentStep).toBe("validate");

    // Step 3: Validate
    const validateResponse: ValidateResponse = {
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
        contents: [],
        checksum: "abc",
        secrets_redacted: false,
        export_options: {
          include_logs: false,
          include_browser_state: false,
          include_memory_vectors: false,
        },
      },
    };
    state = await executeValidateStep(
      state,
      makeExecutorOptions({
        destConfig: runtimeConfig({
          fetchFn: mockFetch(200, validateResponse),
        }),
      }),
    );
    expect(state.currentStep).toBe("preflight-review");

    // Step 4: Preflight review
    const preflightResponse: ImportPreflightResponse = {
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
        schema_version: 1,
        bundle_id: "00000000-0000-4000-8000-000000000000",
        created_at: "2026-03-01T00:00:00Z",
        assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
        origin: { mode: "self-hosted-local" },
        compatibility: {
          min_runtime_version: "0.0.0-test",
          max_runtime_version: null,
        },
        contents: [],
        checksum: "abc",
        secrets_redacted: false,
        export_options: {
          include_logs: false,
          include_browser_state: false,
          include_memory_vectors: false,
        },
      },
    };
    state = await executePreflightStep(
      state,
      makeExecutorOptions({
        destConfig: runtimeConfig({
          fetchFn: mockFetch(200, preflightResponse),
        }),
      }),
    );
    expect(state.currentStep).toBe("transfer");

    // Step 5: Transfer (runtime export + import)
    const importResponse: ImportCommitResponse = {
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
        schema_version: 1,
        bundle_id: "00000000-0000-4000-8000-000000000000",
        created_at: "2026-03-01T00:00:00Z",
        assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
        origin: { mode: "self-hosted-local" },
        compatibility: {
          min_runtime_version: "0.0.0-test",
          max_runtime_version: null,
        },
        contents: [],
        checksum: "abc",
        secrets_redacted: false,
        export_options: {
          include_logs: false,
          include_browser_state: false,
          include_memory_vectors: false,
        },
      },
      warnings: [],
    };

    const sourceFetch = (async () => {
      return new Response(new ArrayBuffer(32), {
        status: 200,
        headers: {
          "Content-Disposition": 'attachment; filename="export.vbundle"',
          "X-Vbundle-Schema-Version": "1",
          "X-Vbundle-Manifest-Sha256": "abc",
        },
      });
    }) as unknown as typeof fetch;

    const destFetch = (async () => {
      return new Response(JSON.stringify(importResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    state = await executeTransferStep(
      state,
      makeExecutorOptions({
        sourceConfig: runtimeConfig({ fetchFn: sourceFetch }),
        destConfig: runtimeConfig({ fetchFn: destFetch }),
      }),
    );
    expect(state.currentStep).toBe("rebind-secrets");

    // Step 6: Rebind secrets
    state = completeRebindSecrets(state);
    expect(state.currentStep).toBe("complete");
    expect(isWizardComplete(state)).toBe(true);

    // Verify all steps are in success state
    for (const step of getStepOrder(state)) {
      expect(state.steps[step].status).toBe("success");
    }
  });

  test("error → retry → success flow", async () => {
    let state = advanceTo("validate");

    // First attempt fails
    state = await executeValidateStep(
      state,
      makeExecutorOptions({
        destConfig: runtimeConfig({
          fetchFn: mockFetch(503, "Service Unavailable"),
        }),
      }),
    );
    expect(state.steps.validate.status).toBe("error");
    expect(canRetryCurrentStep(state)).toBe(true);

    // Reset for retry
    state = resetStepForRetry(state);
    expect(state.steps.validate.status).toBe("idle");

    // Second attempt succeeds
    const validateResponse: ValidateResponse = {
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
        contents: [],
        checksum: "abc",
        secrets_redacted: false,
        export_options: {
          include_logs: false,
          include_browser_state: false,
          include_memory_vectors: false,
        },
      },
    };
    state = await executeValidateStep(
      state,
      makeExecutorOptions({
        destConfig: runtimeConfig({
          fetchFn: mockFetch(200, validateResponse),
        }),
      }),
    );
    expect(state.steps.validate.status).toBe("success");
    expect(state.currentStep).toBe("preflight-review");
  });

  test("persistence/resume round-trip", () => {
    // Build up state to transfer step
    let state = advanceTo("transfer");

    // Simulate interrupted loading state
    state = {
      ...state,
      steps: { ...state.steps, transfer: { status: "loading" } },
      hasBundleData: true,
    };

    // Persist
    const json = serializeWizardState(state);

    // Restore
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();
    expect(restored!.currentStep).toBe("transfer");
    // Bundle data cleared on deserialization
    expect(restored!.hasBundleData).toBe(false);

    // Prepare for resume — loading resets to idle, and since no bundle data,
    // goes back to upload-bundle
    const prepared = prepareForResume(restored!);
    expect(prepared.currentStep).toBe("upload-bundle");
    expect(prepared.steps.transfer.status).toBe("idle");
    expect(prepared.steps["upload-bundle"].status).toBe("idle");

    // Earlier completed steps remain
    expect(prepared.steps["select-direction"].status).toBe("success");
  });

  test("go back and redo flow", () => {
    let state = advanceTo("transfer");

    // Go back to validate
    state = goBackTo(state, "validate");
    expect(state.currentStep).toBe("validate");
    expect(state.steps.validate.status).toBe("idle");
    expect(state.steps["preflight-review"].status).toBe("idle");
    expect(state.steps.transfer.status).toBe("idle");

    // Earlier steps remain successful
    expect(state.steps["select-direction"].status).toBe("success");
    expect(state.steps["upload-bundle"].status).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// isResumable — corrected test for complete state
// ---------------------------------------------------------------------------

describe("isResumable edge cases", () => {
  test("complete state is not resumable", () => {
    const state = advanceTo("complete");
    expect(isResumable(state)).toBe(false);
  });

  test("upload-bundle with direction is resumable", () => {
    const state = advanceTo("upload-bundle");
    expect(isResumable(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Disabled state (step not yet accessible)
// ---------------------------------------------------------------------------

describe("disabled states", () => {
  test("steps beyond current are not accessible and effectively disabled", () => {
    const state = createWizardState();
    expect(isStepAccessible(state, "upload-bundle")).toBe(false);
    expect(isStepAccessible(state, "validate")).toBe(false);
    expect(isStepAccessible(state, "preflight-review")).toBe(false);
    expect(isStepAccessible(state, "transfer")).toBe(false);
    expect(isStepAccessible(state, "rebind-secrets")).toBe(false);
    expect(isStepAccessible(state, "complete")).toBe(false);
  });

  test("current step and earlier steps are accessible", () => {
    const state = advanceTo("transfer");
    expect(isStepAccessible(state, "select-direction")).toBe(true);
    expect(isStepAccessible(state, "upload-bundle")).toBe(true);
    expect(isStepAccessible(state, "validate")).toBe(true);
    expect(isStepAccessible(state, "preflight-review")).toBe(true);
    expect(isStepAccessible(state, "transfer")).toBe(true);
  });
});
