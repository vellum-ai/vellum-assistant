/**
 * Tests for macOS/iOS parity and persistence/resume behavior.
 *
 * Covers:
 * - Cross-platform parity: shared modules produce identical results regardless
 *   of platform context. Serialized state is portable between macOS and iOS.
 * - Persistence/resume at every wizard step: serialize, deserialize, resume,
 *   verify correct screen states.
 * - Interrupted flows: crash during transfer, partial completion, loading states.
 * - Full end-to-end flows: managed-to-self-hosted and self-hosted-to-managed
 *   through all screen view models.
 * - Edge cases: timeouts during polling, stale/expired states, concurrent wizard
 *   instances, state corruption recovery, bundle data loss after deserialization.
 * - Cross-screen consistency: screen transitions maintain consistent state across
 *   validation -> transfer -> rebind screens.
 */

import { describe, expect, test } from "bun:test";

import type {
  ImportCommitResponse,
  ImportPreflightResponse,
  TransportConfig,
  ValidateResponse,
} from "../runtime/migrations/migration-transport.js";
import type {
  MigrationDirection,
  MigrationWizardState,
  StepExecutorOptions,
  WizardStep,
} from "../runtime/migrations/migration-wizard.js";
import {
  canRetryCurrentStep,
  completeRebindSecrets,
  createWizardState,
  deserializeWizardState,
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
import type { RebindTaskCompletionState } from "../runtime/migrations/rebind-secrets-screen.js";
import {
  areAllRequiredTasksComplete,
  completeMigration,
  createTaskCompletionState,
  deriveRebindSecretsScreenState,
  getTaskIds,
  isRebindSecretsScreenAccessible,
  markTaskComplete,
} from "../runtime/migrations/rebind-secrets-screen.js";
import {
  deriveTransferScreenState,
  executeTransferFlow,
  isTransferScreenAccessible,
} from "../runtime/migrations/transfer-progress-screen.js";
import {
  deriveValidationScreenState,
  executeValidationFlow,
  isValidationScreenAccessible,
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

function managedConfig(overrides?: Partial<TransportConfig>): TransportConfig {
  return {
    baseURL: "https://platform.vellum.ai",
    target: "managed",
    authHeader: "session-token-abc",
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

function makePreflightSuccess(): ImportPreflightResponse {
  return {
    can_import: true,
    summary: {
      total_files: 3,
      files_to_create: 1,
      files_to_overwrite: 1,
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
        path: "playbooks/default.md",
        action: "unchanged",
        bundle_size: 2048,
        current_size: 2048,
        bundle_sha256: "mno345",
        current_sha256: "mno345",
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

function makeImportSuccess(): ImportCommitResponse {
  return {
    success: true,
    summary: {
      total_files: 3,
      files_created: 1,
      files_overwritten: 1,
      files_skipped: 1,
      backups_created: 1,
    },
    files: [
      {
        path: "config.json",
        disk_path: "/data/config.json",
        action: "overwritten",
        size: 1024,
        sha256: "abc123",
        backup_path: "/data/config.json.bak",
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
      contents: [{ path: "config.json", sha256: "abc123", size_bytes: 1024 }],
      checksum: "manifest-hash",
      secrets_redacted: false,
      export_options: {
        include_logs: false,
        include_browser_state: false,
        include_memory_vectors: false,
      },
    },
    warnings: ["Backup created for config.json"],
  };
}

/** Advance state to a specific step for testing. */
function advanceTo(
  step: WizardStep,
  direction: MigrationDirection = "managed-to-self-hosted",
): MigrationWizardState {
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
    state = selectDirection(state, direction);
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
      importResult: makeImportSuccess(),
      currentStep: "rebind-secrets",
    };
  }
  if (targetIdx >= 6) {
    state = completeRebindSecrets(state);
  }

  return state;
}

/** Mark all required tasks as complete. */
function completeOnlyRequired(
  state: RebindTaskCompletionState,
): RebindTaskCompletionState {
  let current = state;
  current = markTaskComplete(current, "re-enter-secrets");
  current = markTaskComplete(current, "rebind-channels");
  current = markTaskComplete(current, "reconfigure-auth");
  return current;
}

/** Mark all tasks (including optional) as complete. */
function completeAllTasks(
  state: RebindTaskCompletionState,
): RebindTaskCompletionState {
  let current = state;
  for (const id of getTaskIds()) {
    current = markTaskComplete(current, id);
  }
  return current;
}

// ===========================================================================
// 1. CROSS-PLATFORM PARITY
// ===========================================================================

describe("macOS + iOS parity — shared module determinism", () => {
  test("wizard state machine produces identical results for both directions", () => {
    // Both platforms use the same shared modules, so identical inputs must
    // produce identical outputs regardless of which platform instantiates them.
    const stateA = createWizardState();
    const stateB = createWizardState();

    // Compare structure (timestamps may differ slightly, so strip them)
    const normalize = (s: MigrationWizardState) => ({
      ...s,
      createdAt: "FIXED",
      updatedAt: "FIXED",
    });

    expect(normalize(stateA)).toEqual(normalize(stateB));

    // Advance both through the same transitions
    const advA = selectDirection(stateA, "managed-to-self-hosted");
    const advB = selectDirection(stateB, "managed-to-self-hosted");

    expect(normalize(advA).currentStep).toBe(normalize(advB).currentStep);
    expect(normalize(advA).direction).toBe(normalize(advB).direction);
    expect(normalize(advA).steps).toEqual(normalize(advB).steps);
  });

  test("serialized state is portable — serialize on 'macOS', deserialize on 'iOS'", () => {
    // Simulate creating state on one platform and deserializing on another.
    // The key invariant: the deserialized state must be structurally identical
    // (except hasBundleData which is always false after deserialization).
    const original = advanceTo("rebind-secrets", "managed-to-self-hosted");
    const json = serializeWizardState(original);

    // "Transfer" the JSON string to another platform
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    // All fields except hasBundleData and timestamps should match
    expect(restored!.currentStep).toBe(original.currentStep);
    expect(restored!.direction).toBe(original.direction);
    expect(restored!.hasBundleData).toBe(false); // Always false after deserialization

    // Step states should be identical
    for (const step of getStepOrder(original)) {
      expect(restored!.steps[step].status).toBe(original.steps[step].status);
    }

    // Results should be preserved
    expect(restored!.validateResult).toEqual(original.validateResult);
    expect(restored!.preflightResult).toEqual(original.preflightResult);
    expect(restored!.importResult).toEqual(original.importResult);
  });

  test("state machine transitions produce identical step orders for both directions", () => {
    const m2s = getStepOrder(
      advanceTo("upload-bundle", "managed-to-self-hosted"),
    );
    const s2m = getStepOrder(
      advanceTo("upload-bundle", "self-hosted-to-managed"),
    );

    // Both directions use the same step sequence
    expect(m2s).toEqual(s2m);
    expect(m2s).toEqual([
      "select-direction",
      "upload-bundle",
      "validate",
      "preflight-review",
      "transfer",
      "rebind-secrets",
      "complete",
    ]);
  });

  test("validation screen view model produces identical output for same wizard state", () => {
    const stateM2S = advanceTo("transfer", "managed-to-self-hosted");
    const stateS2M = advanceTo("transfer", "self-hosted-to-managed");

    // Both should produce success screen states with identical structure
    // (only difference is the direction field on wizard state)
    const screenM2S = deriveValidationScreenState(stateM2S);
    const screenS2M = deriveValidationScreenState(stateS2M);

    expect(screenM2S.phase).toBe("success");
    expect(screenS2M.phase).toBe("success");

    if (screenM2S.phase === "success" && screenS2M.phase === "success") {
      expect(screenM2S.validation).toEqual(screenS2M.validation);
      expect(screenM2S.preflight).toEqual(screenS2M.preflight);
    }
  });

  test("transfer screen view model produces identical output for same wizard state", () => {
    const stateM2S = advanceTo("rebind-secrets", "managed-to-self-hosted");
    const stateS2M = advanceTo("rebind-secrets", "self-hosted-to-managed");

    const screenM2S = deriveTransferScreenState(stateM2S);
    const screenS2M = deriveTransferScreenState(stateS2M);

    expect(screenM2S.phase).toBe("success");
    expect(screenS2M.phase).toBe("success");

    if (screenM2S.phase === "success" && screenS2M.phase === "success") {
      expect(screenM2S.importSummary).toEqual(screenS2M.importSummary);
    }
  });

  test("rebind secrets screen produces identical output for same wizard state", () => {
    const stateM2S = advanceTo("rebind-secrets", "managed-to-self-hosted");
    const stateS2M = advanceTo("rebind-secrets", "self-hosted-to-managed");

    const completion = createTaskCompletionState();
    const screenM2S = deriveRebindSecretsScreenState(stateM2S, completion);
    const screenS2M = deriveRebindSecretsScreenState(stateS2M, completion);

    expect(screenM2S.phase).toBe("active");
    expect(screenS2M.phase).toBe("active");

    if (screenM2S.phase === "active" && screenS2M.phase === "active") {
      expect(screenM2S.tasks).toEqual(screenS2M.tasks);
      expect(screenM2S.requiredCount).toBe(screenS2M.requiredCount);
      expect(screenM2S.totalCount).toBe(screenS2M.totalCount);
    }
  });

  test("query helpers produce identical results for both directions", () => {
    const stateM2S = advanceTo("transfer", "managed-to-self-hosted");
    const stateS2M = advanceTo("transfer", "self-hosted-to-managed");

    expect(getCurrentStepIndex(stateM2S)).toBe(getCurrentStepIndex(stateS2M));
    expect(getTotalSteps()).toBe(7);
    expect(isWizardComplete(stateM2S)).toBe(false);
    expect(isWizardComplete(stateS2M)).toBe(false);

    const completeM2S = advanceTo("complete", "managed-to-self-hosted");
    const completeS2M = advanceTo("complete", "self-hosted-to-managed");
    expect(isWizardComplete(completeM2S)).toBe(true);
    expect(isWizardComplete(completeS2M)).toBe(true);
  });

  test("transition validation is symmetric across platform contexts", () => {
    const state = advanceTo("validate");

    // Forward transition validation
    const forwardResult = validateWizardTransition(state, "preflight-review");
    expect(forwardResult.valid).toBe(false); // validate step is idle, not success

    // Same call with identical state produces identical result
    const forwardResult2 = validateWizardTransition(state, "preflight-review");
    expect(forwardResult2).toEqual(forwardResult);

    // Back transition is always valid
    const backResult = validateWizardTransition(state, "upload-bundle");
    expect(backResult.valid).toBe(true);
  });
});

// ===========================================================================
// 2. PERSISTENCE / RESUME BEHAVIOR
// ===========================================================================

describe("persistence/resume — serialize at each step", () => {
  test("persist and resume at select-direction step", () => {
    const state = createWizardState();
    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();
    expect(restored!.currentStep).toBe("select-direction");
    expect(isResumable(restored!)).toBe(false); // First step, nothing to resume
  });

  test("persist and resume at upload-bundle step", () => {
    const state = advanceTo("upload-bundle");
    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();
    expect(restored!.currentStep).toBe("upload-bundle");
    expect(restored!.direction).toBe("managed-to-self-hosted");
    expect(isResumable(restored!)).toBe(true);

    const resumed = prepareForResume(restored!);
    expect(resumed.currentStep).toBe("upload-bundle");
  });

  test("persist and resume at validate step — redirects to upload-bundle (no bundle data)", () => {
    const state = advanceTo("validate");
    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();
    expect(restored!.hasBundleData).toBe(false);

    const resumed = prepareForResume(restored!);
    // Validate step needs bundle data, so redirect to upload-bundle
    expect(resumed.currentStep).toBe("upload-bundle");
  });

  test("persist and resume at preflight-review step — redirects to upload-bundle (no bundle data)", () => {
    const state = advanceTo("preflight-review");
    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    const resumed = prepareForResume(restored!);
    expect(resumed.currentStep).toBe("upload-bundle");
  });

  test("persist and resume at transfer step — redirects to upload-bundle (no bundle data)", () => {
    const state = advanceTo("transfer");
    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    const resumed = prepareForResume(restored!);
    expect(resumed.currentStep).toBe("upload-bundle");
  });

  test("persist and resume at rebind-secrets step — stays at rebind-secrets (no bundle needed)", () => {
    const state = advanceTo("rebind-secrets");
    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();
    expect(isResumable(restored!)).toBe(true);

    const resumed = prepareForResume(restored!);
    expect(resumed.currentStep).toBe("rebind-secrets");
  });

  test("persist and resume at complete step — not resumable", () => {
    const state = advanceTo("complete");
    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();
    expect(isResumable(restored!)).toBe(false);
  });

  test("persist and resume with loading status resets to idle", () => {
    let state = advanceTo("validate");
    state = {
      ...state,
      steps: { ...state.steps, validate: { status: "loading" } },
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    const resumed = prepareForResume(restored!);
    // Loading was reset + redirected to upload-bundle because no bundle data
    expect(resumed.currentStep).toBe("upload-bundle");
  });

  test("persist and resume with error status preserves error details", () => {
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
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();
    expect(restored!.steps.validate.status).toBe("error");
    expect(restored!.steps.validate.error?.message).toBe("validate: HTTP 500");
    expect(restored!.steps.validate.error?.retryable).toBe(true);
  });

  test("results survive round-trip serialization", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      validateResult: makeValidateSuccess(),
      preflightResult: makePreflightSuccess(),
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    // Validate result
    expect(restored!.validateResult).toBeDefined();
    expect(restored!.validateResult!.is_valid).toBe(true);
    if (restored!.validateResult!.is_valid) {
      expect(restored!.validateResult!.manifest.schema_version).toBe(1);
    }

    // Preflight result
    expect(restored!.preflightResult).toBeDefined();
    expect(restored!.preflightResult!.can_import).toBe(true);
    if (restored!.preflightResult!.can_import) {
      expect(restored!.preflightResult!.summary.total_files).toBe(3);
    }
  });

  test("import result survives round-trip serialization", () => {
    let state = advanceTo("rebind-secrets");
    state = {
      ...state,
      importResult: makeImportSuccess(),
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    expect(restored!.importResult).toBeDefined();
    expect(restored!.importResult!.success).toBe(true);
    if (restored!.importResult!.success) {
      expect(restored!.importResult!.summary.total_files).toBe(3);
      expect(restored!.importResult!.warnings).toHaveLength(1);
    }
  });
});

// ===========================================================================
// 3. INTERRUPTED FLOWS
// ===========================================================================

describe("interrupted flow recovery", () => {
  test("crash during transfer loading — resume resets to upload-bundle", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: { ...state.steps, transfer: { status: "loading" } },
      exportResult: {
        ok: true,
        filename: "export.vbundle",
        schemaVersion: 1,
        checksum: "abc",
      },
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    const resumed = prepareForResume(restored!);
    // Transfer needs bundle data; since hasBundleData=false after deserialization,
    // redirect to upload-bundle
    expect(resumed.currentStep).toBe("upload-bundle");
    // Export result is preserved in the state even though we go back
    // (the user will need to re-upload the bundle)
  });

  test("crash during validate loading — resume resets to upload-bundle", () => {
    let state = advanceTo("validate");
    state = {
      ...state,
      steps: { ...state.steps, validate: { status: "loading" } },
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    const resumed = prepareForResume(restored!);

    expect(resumed.currentStep).toBe("upload-bundle");
    expect(resumed.steps.validate.status).toBe("idle");
  });

  test("crash during preflight-review loading — resume resets to upload-bundle", () => {
    let state = advanceTo("preflight-review");
    state = {
      ...state,
      steps: { ...state.steps, "preflight-review": { status: "loading" } },
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    const resumed = prepareForResume(restored!);

    expect(resumed.currentStep).toBe("upload-bundle");
    expect(resumed.steps["preflight-review"].status).toBe("idle");
  });

  test("partial completion — validate done but preflight crashed", () => {
    let state = advanceTo("preflight-review");
    // Validation succeeded, but preflight was in progress when crash occurred
    state = {
      ...state,
      validateResult: makeValidateSuccess(),
      steps: {
        ...state.steps,
        validate: { status: "success" },
        "preflight-review": { status: "loading" },
      },
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    const resumed = prepareForResume(restored!);

    // Goes to upload-bundle because no bundle data
    expect(resumed.currentStep).toBe("upload-bundle");
    // Results are cleared when rewinding to upload-bundle (no bundle data)
    expect(resumed.validateResult).toBeUndefined();
  });

  test("partial completion — export done but import crashed", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: { ...state.steps, transfer: { status: "loading" } },
      exportResult: {
        ok: true,
        filename: "export.vbundle",
        schemaVersion: 1,
        checksum: "abc",
      },
      // No importResult — import had not started or crashed
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    const resumed = prepareForResume(restored!);

    // Goes back to upload-bundle (no bundle data)
    expect(resumed.currentStep).toBe("upload-bundle");
    // Results are cleared when rewinding to upload-bundle (no bundle data)
    expect(resumed.exportResult).toBeUndefined();
  });

  test("error state at transfer — user can retry after resume at rebind step doesn't apply", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: {
        ...state.steps,
        transfer: {
          status: "error",
          error: {
            message: "import: HTTP 500",
            code: "HTTP_500",
            retryable: true,
          },
        },
      },
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    // Without preparing for resume (raw deserialized state), error is preserved
    expect(restored!.steps.transfer.status).toBe("error");
    expect(canRetryCurrentStep(restored!)).toBe(true);
  });
});

// ===========================================================================
// 4. FULL END-TO-END FLOWS
// ===========================================================================

describe("full end-to-end — managed-to-self-hosted migration", () => {
  test("complete flow through all screen view models", async () => {
    // Step 1: Create wizard and select direction
    let state = createWizardState();
    expect(deriveValidationScreenState(state).phase).toBe("disabled");
    expect(deriveTransferScreenState(state).phase).toBe("disabled");
    expect(
      deriveRebindSecretsScreenState(state, createTaskCompletionState()).phase,
    ).toBe("disabled");

    state = selectDirection(state, "managed-to-self-hosted");
    expect(state.currentStep).toBe("upload-bundle");
    expect(state.direction).toBe("managed-to-self-hosted");

    // Step 2: Upload bundle
    state = setBundleUploaded(state);
    expect(state.currentStep).toBe("validate");
    expect(state.hasBundleData).toBe(true);

    // Step 3: Validate + preflight
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

    const validateOptions = makeExecutorOptions({
      destConfig: runtimeConfig({ fetchFn: sequentialFetch }),
    });

    state = await executeValidationFlow(state, validateOptions);
    expect(state.currentStep).toBe("transfer");

    // Verify validation screen shows success
    const valScreen = deriveValidationScreenState(state);
    expect(valScreen.phase).toBe("success");
    if (valScreen.phase === "success") {
      expect(valScreen.validation.isValid).toBe(true);
      expect(valScreen.preflight.summary.totalFiles).toBe(3);
    }

    // Step 4: Transfer (managed export via async polling + runtime import)
    const archiveBytes = new ArrayBuffer(32);
    const importResponse = makeImportSuccess();

    let exportCallCount = 0;
    const sourceFetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/export/")) {
        // Managed export: initiate async job
        return new Response(
          JSON.stringify({ job_id: "exp-m2sh", status: "pending" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (urlStr.includes("/export/") && urlStr.includes("/status/")) {
        exportCallCount++;
        if (exportCallCount === 1) {
          // First poll: still in progress
          return new Response(
            JSON.stringify({
              job_id: "exp-m2sh",
              status: "in_progress",
              progress: 50,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        // Second poll: complete with download URL
        return new Response(
          JSON.stringify({
            job_id: "exp-m2sh",
            status: "complete",
            download_url: "https://platform.vellum.ai/downloads/exp-m2sh",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (urlStr.includes("/downloads/")) {
        // Download the exported archive
        return new Response(archiveBytes, {
          status: 200,
          headers: {
            "Content-Disposition": 'attachment; filename="export.vbundle"',
          },
        });
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    const destFetch = (async () => {
      return new Response(JSON.stringify(importResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const transferOptions = makeExecutorOptions({
      sourceConfig: managedConfig({ fetchFn: sourceFetch }),
      destConfig: runtimeConfig({ fetchFn: destFetch }),
    });

    state = await executeTransferFlow(state, transferOptions);
    expect(state.currentStep).toBe("rebind-secrets");

    // Verify transfer screen shows success
    const transferScreen = deriveTransferScreenState(state);
    expect(transferScreen.phase).toBe("success");
    if (transferScreen.phase === "success") {
      expect(transferScreen.importSummary.totalFiles).toBe(3);
    }

    // Step 5: Rebind secrets
    let completion = createTaskCompletionState();
    let rebindScreen = deriveRebindSecretsScreenState(state, completion);
    expect(rebindScreen.phase).toBe("active");
    if (rebindScreen.phase === "active") {
      expect(rebindScreen.allRequiredComplete).toBe(false);
    }

    // Complete required tasks one by one
    completion = markTaskComplete(completion, "re-enter-secrets");
    completion = markTaskComplete(completion, "rebind-channels");
    completion = markTaskComplete(completion, "reconfigure-auth");

    rebindScreen = deriveRebindSecretsScreenState(state, completion);
    if (rebindScreen.phase === "active") {
      expect(rebindScreen.allRequiredComplete).toBe(true);
    }

    // Step 6: Complete migration
    state = completeMigration(state, completion);
    expect(state.currentStep).toBe("complete");
    expect(isWizardComplete(state)).toBe(true);

    // All screens should still show their success states
    expect(deriveValidationScreenState(state).phase).toBe("success");
    expect(deriveTransferScreenState(state).phase).toBe("success");
    expect(deriveRebindSecretsScreenState(state, completion).phase).toBe(
      "complete",
    );
  });
});

describe("full end-to-end — self-hosted-to-managed migration", () => {
  test("complete flow with managed export (async polling)", async () => {
    // Step 1: Create wizard and select direction
    let state = createWizardState();
    state = selectDirection(state, "self-hosted-to-managed");
    expect(state.direction).toBe("self-hosted-to-managed");

    // Step 2: Upload bundle
    state = setBundleUploaded(state);

    // Step 3: Validate + preflight
    const validateSuccess = makeValidateSuccess();
    const preflightSuccess = makePreflightSuccess();

    let valCallCount = 0;
    const sequentialFetch = (async () => {
      valCallCount++;
      if (valCallCount === 1) {
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

    state = await executeValidationFlow(
      state,
      makeExecutorOptions({
        destConfig: managedConfig({ fetchFn: sequentialFetch }),
      }),
    );
    expect(state.currentStep).toBe("transfer");

    // Step 4: Transfer with managed source (async polling)
    const importResponse = makeImportSuccess();

    const sourceFetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/export")) {
        // Runtime export returns binary directly
        return new Response(new ArrayBuffer(32), {
          status: 200,
          headers: {
            "Content-Disposition": 'attachment; filename="export.vbundle"',
            "X-Vbundle-Schema-Version": "1",
            "X-Vbundle-Manifest-Sha256": "abc",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    const destFetch = (async () => {
      return new Response(JSON.stringify(importResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    state = await executeTransferFlow(
      state,
      makeExecutorOptions({
        sourceConfig: runtimeConfig({ fetchFn: sourceFetch }),
        destConfig: managedConfig({ fetchFn: destFetch }),
      }),
    );
    expect(state.currentStep).toBe("rebind-secrets");

    // Step 5-6: Rebind and complete
    const completion = completeOnlyRequired(createTaskCompletionState());
    state = completeMigration(state, completion);
    expect(isWizardComplete(state)).toBe(true);
  });
});

// ===========================================================================
// 5. EDGE CASES
// ===========================================================================

describe("edge cases — import failures and transport errors", () => {
  test("transfer step handles import validation failure as retryable error", async () => {
    const destFetch = (async () => {
      return new Response(
        JSON.stringify({
          success: false,
          reason: "validation_failed",
          message: "Manifest SHA mismatch",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const state = advanceTo("transfer");
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({ fetchFn: destFetch }),
    });

    const result = await executeTransferFlow(state, options);
    expect(result.steps.transfer.status).toBe("error");
    expect(result.steps.transfer.error?.message).toContain(
      "Manifest SHA mismatch",
    );
    expect(result.steps.transfer.error?.code).toBe("validation_failed");

    const screen = deriveTransferScreenState(result);
    expect(screen.phase).toBe("error");
    if (screen.phase === "error") {
      expect(screen.failedPhase).toBe("import");
      expect(screen.canRetry).toBe(true);
    }
  });

  test("transfer step handles import write failure", async () => {
    const destFetch = (async () => {
      return new Response(
        JSON.stringify({
          success: false,
          reason: "write_failed",
          message: "Disk full",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const state = advanceTo("transfer");
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({ fetchFn: destFetch }),
    });

    const result = await executeTransferFlow(state, options);
    expect(result.steps.transfer.status).toBe("error");
    expect(result.steps.transfer.error?.code).toBe("write_failed");
    expect(result.steps.transfer.error?.retryable).toBe(true);
  });

  test("transfer step handles import extraction failure", async () => {
    const destFetch = (async () => {
      return new Response(
        JSON.stringify({
          success: false,
          reason: "extraction_failed",
          message: "Corrupt archive",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const state = advanceTo("transfer");
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({ fetchFn: destFetch }),
    });

    const result = await executeTransferFlow(state, options);
    expect(result.steps.transfer.status).toBe("error");
    expect(result.steps.transfer.error?.message).toContain("Corrupt archive");
  });

  test("transfer step handles destination HTTP 503 as retryable transport error", async () => {
    const state = advanceTo("transfer");
    const options = makeExecutorOptions({
      destConfig: runtimeConfig({
        fetchFn: mockFetch(503, "Service Unavailable"),
      }),
    });

    const result = await executeTransferFlow(state, options);
    expect(result.steps.transfer.status).toBe("error");

    const screen = deriveTransferScreenState(result);
    expect(screen.phase).toBe("error");
    if (screen.phase === "error") {
      expect(screen.canRetry).toBe(true);
      expect(screen.failedPhase).toBe("import");
    }
  });

  test("transfer step handles destination HTTP 429 rate limit as retryable", async () => {
    const archiveBytes = new ArrayBuffer(32);
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

    const state = advanceTo("transfer");
    const options = makeExecutorOptions({
      sourceConfig: runtimeConfig({ fetchFn: sourceFetch }),
      destConfig: runtimeConfig({
        fetchFn: mockFetch(429, "Too Many Requests"),
      }),
    });

    const result = await executeTransferFlow(state, options);
    expect(result.steps.transfer.status).toBe("error");
    expect(result.steps.transfer.error?.retryable).toBe(true);
    expect(result.steps.transfer.error?.code).toBe("HTTP_429");
  });
});

describe("edge cases — stale/expired states", () => {
  test("very old serialized state deserializes correctly", () => {
    // Simulate a state serialized months ago
    const oldState: MigrationWizardState = {
      currentStep: "rebind-secrets",
      direction: "managed-to-self-hosted",
      steps: {
        "select-direction": { status: "success" },
        "upload-bundle": { status: "success" },
        validate: { status: "success" },
        "preflight-review": { status: "success" },
        transfer: { status: "success" },
        "rebind-secrets": { status: "idle" },
        complete: { status: "idle" },
      },
      hasBundleData: true,
      createdAt: "2024-01-01T00:00:00Z", // Over a year old
      updatedAt: "2024-01-01T01:00:00Z",
    };

    const json = JSON.stringify(oldState);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();
    expect(restored!.currentStep).toBe("rebind-secrets");
    expect(restored!.hasBundleData).toBe(false); // Always false after deserialization

    // Resume should work even for stale state
    expect(isResumable(restored!)).toBe(true);
    const resumed = prepareForResume(restored!);
    expect(resumed.currentStep).toBe("rebind-secrets");
  });

  test("state with expired timestamps still functions correctly", () => {
    const state = advanceTo("transfer");
    // Manually set old timestamps
    const oldState = {
      ...state,
      createdAt: "2023-06-15T00:00:00Z",
      updatedAt: "2023-06-15T01:00:00Z",
    };

    const json = serializeWizardState(oldState);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();
    expect(restored!.createdAt).toBe("2023-06-15T00:00:00Z");

    // The wizard should still work — transfer step is import-only
    const screen = deriveTransferScreenState(restored!);
    expect(screen.phase).toBe("importing");
  });
});

describe("edge cases — concurrent wizard instances", () => {
  test("two independent wizard instances maintain separate state", () => {
    // Advance two wizards to different steps
    const w1Advanced = advanceTo("transfer", "managed-to-self-hosted");
    const w2Advanced = advanceTo("upload-bundle", "self-hosted-to-managed");

    // States are completely independent
    expect(w1Advanced.currentStep).toBe("transfer");
    expect(w2Advanced.currentStep).toBe("upload-bundle");
    expect(w1Advanced.direction).toBe("managed-to-self-hosted");
    expect(w2Advanced.direction).toBe("self-hosted-to-managed");

    // Serializing both produces independent JSON
    const json1 = serializeWizardState(w1Advanced);
    const json2 = serializeWizardState(w2Advanced);
    expect(json1).not.toBe(json2);

    // Deserializing restores independent state
    const restored1 = deserializeWizardState(json1);
    const restored2 = deserializeWizardState(json2);
    expect(restored1!.currentStep).toBe("transfer");
    expect(restored2!.currentStep).toBe("upload-bundle");
  });

  test("modifying one wizard does not affect a serialized snapshot of another", () => {
    let wizard = advanceTo("rebind-secrets");
    const snapshot = serializeWizardState(wizard);

    // Advance the wizard to complete
    wizard = completeRebindSecrets(wizard);
    expect(wizard.currentStep).toBe("complete");

    // The snapshot should still restore to rebind-secrets
    const restored = deserializeWizardState(snapshot);
    expect(restored!.currentStep).toBe("rebind-secrets");
    expect(isWizardComplete(restored!)).toBe(false);
  });
});

describe("edge cases — state corruption recovery", () => {
  test("empty string returns undefined", () => {
    expect(deserializeWizardState("")).toBeUndefined();
  });

  test("null returns undefined", () => {
    expect(deserializeWizardState("null")).toBeUndefined();
  });

  test("invalid JSON returns undefined", () => {
    expect(deserializeWizardState("{invalid json}")).toBeUndefined();
  });

  test("valid JSON but missing required fields returns undefined", () => {
    expect(deserializeWizardState('{"foo": "bar"}')).toBeUndefined();
  });

  test("missing currentStep returns undefined", () => {
    const partial = {
      steps: {},
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    expect(deserializeWizardState(JSON.stringify(partial))).toBeUndefined();
  });

  test("unknown currentStep value returns undefined", () => {
    const invalid: Record<string, unknown> = {
      currentStep: "nonexistent-step",
      steps: {
        "select-direction": { status: "idle" },
        "upload-bundle": { status: "idle" },
        validate: { status: "idle" },
        "preflight-review": { status: "idle" },
        transfer: { status: "idle" },
        "rebind-secrets": { status: "idle" },
        complete: { status: "idle" },
      },
      hasBundleData: false,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    expect(deserializeWizardState(JSON.stringify(invalid))).toBeUndefined();
  });

  test("missing step entries returns undefined", () => {
    const incomplete = {
      currentStep: "validate",
      steps: {
        "select-direction": { status: "success" },
        // Missing other steps
      },
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    expect(deserializeWizardState(JSON.stringify(incomplete))).toBeUndefined();
  });

  test("step with missing status returns undefined", () => {
    const badStatus = {
      currentStep: "validate",
      steps: {
        "select-direction": { status: "success" },
        "upload-bundle": { status: "success" },
        validate: {}, // Missing status
        "preflight-review": { status: "idle" },
        transfer: { status: "idle" },
        "rebind-secrets": { status: "idle" },
        complete: { status: "idle" },
      },
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    expect(deserializeWizardState(JSON.stringify(badStatus))).toBeUndefined();
  });

  test("corrupted JSON with partial data is safely rejected", () => {
    const truncated = '{"currentStep":"validate","steps":{"select-direction":{';
    expect(deserializeWizardState(truncated)).toBeUndefined();
  });

  test("array instead of object returns undefined", () => {
    expect(deserializeWizardState("[1, 2, 3]")).toBeUndefined();
  });

  test("number instead of object returns undefined", () => {
    expect(deserializeWizardState("42")).toBeUndefined();
  });
});

describe("edge cases — bundle data loss after deserialization", () => {
  test("hasBundleData is always false after deserialization", () => {
    const state = advanceTo("validate");
    expect(state.hasBundleData).toBe(true);

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored!.hasBundleData).toBe(false);
  });

  test("all bundle-requiring steps redirect to upload-bundle on resume without bundle data", () => {
    const bundleRequiringSteps: WizardStep[] = [
      "validate",
      "preflight-review",
      "transfer",
    ];

    for (const step of bundleRequiringSteps) {
      const state = advanceTo(step);
      const json = serializeWizardState(state);
      const restored = deserializeWizardState(json);
      const resumed = prepareForResume(restored!);

      expect(resumed.currentStep).toBe("upload-bundle");
    }
  });

  test("non-bundle-requiring steps stay in place on resume", () => {
    // rebind-secrets does not need bundle data
    const state = advanceTo("rebind-secrets");
    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    const resumed = prepareForResume(restored!);

    expect(resumed.currentStep).toBe("rebind-secrets");
  });

  test("direction survives but step results are cleared when bundle data is lost", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      validateResult: makeValidateSuccess(),
      preflightResult: makePreflightSuccess(),
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    const resumed = prepareForResume(restored!);

    // Redirected to upload-bundle; direction is preserved but results are cleared
    expect(resumed.currentStep).toBe("upload-bundle");
    expect(resumed.direction).toBe("managed-to-self-hosted");
    expect(resumed.validateResult).toBeUndefined();
    expect(resumed.preflightResult).toBeUndefined();
  });
});

// ===========================================================================
// 6. CROSS-SCREEN CONSISTENCY
// ===========================================================================

describe("cross-screen consistency — validation -> transfer -> rebind", () => {
  test("all screens report disabled before direction is selected", () => {
    const state = createWizardState();
    const completion = createTaskCompletionState();

    expect(deriveValidationScreenState(state).phase).toBe("disabled");
    expect(deriveTransferScreenState(state).phase).toBe("disabled");
    expect(deriveRebindSecretsScreenState(state, completion).phase).toBe(
      "disabled",
    );
  });

  test("only validation screen is accessible at validate step", () => {
    const state = advanceTo("validate");

    expect(isValidationScreenAccessible(state)).toBe(true);
    expect(isTransferScreenAccessible(state)).toBe(false);
    expect(isRebindSecretsScreenAccessible(state)).toBe(false);
  });

  test("validation and transfer screens accessible at transfer step", () => {
    const state = advanceTo("transfer");

    expect(isValidationScreenAccessible(state)).toBe(true);
    expect(isTransferScreenAccessible(state)).toBe(true);
    expect(isRebindSecretsScreenAccessible(state)).toBe(false);
  });

  test("all screens accessible at rebind-secrets step", () => {
    const state = advanceTo("rebind-secrets");

    // Validation screen shows success from earlier steps
    expect(deriveValidationScreenState(state).phase).toBe("success");
    // Transfer screen shows success
    expect(deriveTransferScreenState(state).phase).toBe("success");
    // Rebind screen is active
    expect(isRebindSecretsScreenAccessible(state)).toBe(true);
  });

  test("all screens show their success states at complete step", () => {
    const state = advanceTo("complete");
    const completion = completeAllTasks(createTaskCompletionState());

    expect(deriveValidationScreenState(state).phase).toBe("success");
    expect(deriveTransferScreenState(state).phase).toBe("success");
    expect(deriveRebindSecretsScreenState(state, completion).phase).toBe(
      "complete",
    );
  });

  test("going back from transfer resets transfer but preserves validation", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      validateResult: makeValidateSuccess(),
      preflightResult: makePreflightSuccess(),
    };

    // Go back to preflight-review
    const backState = goBackTo(state, "preflight-review");

    // Validation screen should still show results
    const valScreen = deriveValidationScreenState(backState);
    expect(valScreen.phase).toBe("loading"); // preflight idle means "preparing"

    // Transfer screen should be disabled
    expect(deriveTransferScreenState(backState).phase).toBe("disabled");
  });

  test("going back from rebind-secrets resets rebind and transfer", () => {
    let state = advanceTo("rebind-secrets");
    state = {
      ...state,
      validateResult: makeValidateSuccess(),
      preflightResult: makePreflightSuccess(),
      importResult: makeImportSuccess(),
    };

    // Go back to transfer
    const backState = goBackTo(state, "transfer");

    expect(backState.currentStep).toBe("transfer");
    expect(backState.steps["rebind-secrets"].status).toBe("idle");
    expect(backState.steps.transfer.status).toBe("idle");

    // Validation results should be preserved
    expect(backState.validateResult).toBeDefined();
    expect(backState.preflightResult).toBeDefined();
    // Transfer results should be cleared
    expect(backState.exportResult).toBeUndefined();
    expect(backState.importResult).toBeUndefined();
  });

  test("screen states are consistent through full serialize/resume cycle at each step", () => {
    const steps: WizardStep[] = [
      "select-direction",
      "upload-bundle",
      "validate",
      "preflight-review",
      "transfer",
      "rebind-secrets",
      "complete",
    ];

    for (const step of steps) {
      const state = advanceTo(step);
      const json = serializeWizardState(state);
      const restored = deserializeWizardState(json);
      expect(restored).toBeDefined();

      // Screen derivation should not throw for any step
      const valScreen = deriveValidationScreenState(restored!);
      const transferScreen = deriveTransferScreenState(restored!);
      const rebindScreen = deriveRebindSecretsScreenState(
        restored!,
        createTaskCompletionState(),
      );

      // All screens should return a valid phase
      expect(valScreen.phase).toBeDefined();
      expect(transferScreen.phase).toBeDefined();
      expect(rebindScreen.phase).toBeDefined();
    }
  });

  test("validation screen success data is consistent with preflight results", () => {
    const state = advanceTo("transfer");
    const screen = deriveValidationScreenState(state);

    if (screen.phase === "success") {
      const preflightResult = state.preflightResult;
      expect(preflightResult).toBeDefined();

      if (preflightResult && preflightResult.can_import) {
        // Screen summary should match raw preflight data
        expect(screen.preflight.summary.totalFiles).toBe(
          preflightResult.summary.total_files,
        );
        expect(screen.preflight.summary.filesToCreate).toBe(
          preflightResult.summary.files_to_create,
        );
        expect(screen.preflight.summary.filesToOverwrite).toBe(
          preflightResult.summary.files_to_overwrite,
        );
        expect(screen.preflight.summary.filesUnchanged).toBe(
          preflightResult.summary.files_unchanged,
        );

        // File count should match
        expect(screen.preflight.files.length).toBe(
          preflightResult.files.length,
        );
      }
    }
  });

  test("transfer screen import summary is consistent with import result", () => {
    const state = advanceTo("rebind-secrets");
    const screen = deriveTransferScreenState(state);

    if (screen.phase === "success") {
      const importResult = state.importResult;
      expect(importResult).toBeDefined();

      if (importResult && importResult.success) {
        expect(screen.importSummary.totalFiles).toBe(
          importResult.summary.total_files,
        );
        expect(screen.importSummary.filesCreated).toBe(
          importResult.summary.files_created,
        );
        expect(screen.importSummary.filesOverwritten).toBe(
          importResult.summary.files_overwritten,
        );
        expect(screen.importSummary.filesSkipped).toBe(
          importResult.summary.files_skipped,
        );
        expect(screen.importSummary.backupsCreated).toBe(
          importResult.summary.backups_created,
        );
      }
    }
  });

  test("rebind task count stays consistent throughout the wizard lifecycle", () => {
    const taskIds = getTaskIds();
    const expectedTaskCount = 4;

    expect(taskIds.length).toBe(expectedTaskCount);

    // At every step, if the screen is active, it should show the same tasks
    const state = advanceTo("rebind-secrets");
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(state, completion);

    if (screen.phase === "active") {
      expect(screen.totalCount).toBe(expectedTaskCount);
      expect(screen.tasks.length).toBe(expectedTaskCount);
      // Task IDs match
      const screenTaskIds = screen.tasks.map((t) => t.id);
      expect(screenTaskIds).toEqual([...taskIds]);
    }
  });
});

describe("cross-screen consistency — error propagation", () => {
  test("validation error does not leak into transfer or rebind screens", () => {
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
    };

    // Validation screen shows the error
    const valScreen = deriveValidationScreenState(state);
    expect(valScreen.phase).toBe("transport-error");

    // Transfer and rebind screens should be disabled, not errored
    expect(deriveTransferScreenState(state).phase).toBe("disabled");
    expect(
      deriveRebindSecretsScreenState(state, createTaskCompletionState()).phase,
    ).toBe("disabled");
  });

  test("transfer error does not leak into validation or rebind screens", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: {
        ...state.steps,
        transfer: {
          status: "error",
          error: {
            message: "export: HTTP 500",
            code: "HTTP_500",
            retryable: true,
          },
        },
      },
    };

    // Transfer screen shows the error
    const transferScreen = deriveTransferScreenState(state);
    expect(transferScreen.phase).toBe("error");

    // Validation screen should still show success (validate and preflight passed)
    const valScreen = deriveValidationScreenState(state);
    expect(valScreen.phase).toBe("success");

    // Rebind screen should be disabled
    expect(
      deriveRebindSecretsScreenState(state, createTaskCompletionState()).phase,
    ).toBe("disabled");
  });
});

describe("cross-screen consistency — step accessibility invariants", () => {
  test("step accessibility is monotonically increasing through normal flow", () => {
    const steps: WizardStep[] = [
      "select-direction",
      "upload-bundle",
      "validate",
      "preflight-review",
      "transfer",
      "rebind-secrets",
    ];

    // At each step, all previous steps should be accessible (can go back)
    for (let i = 0; i < steps.length; i++) {
      const state = advanceTo(steps[i]);
      for (let j = 0; j < i; j++) {
        expect(isStepAccessible(state, steps[j])).toBe(true);
      }
    }
  });

  test("complete step is terminal — no transitions allowed", () => {
    const state = advanceTo("complete");
    const steps: WizardStep[] = [
      "select-direction",
      "upload-bundle",
      "validate",
      "preflight-review",
      "transfer",
      "rebind-secrets",
    ];

    for (const step of steps) {
      const result = validateWizardTransition(state, step);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("terminal");
    }
  });
});

// ===========================================================================
// 7. ADDITIONAL PERSISTENCE EDGE CASES
// ===========================================================================

describe("persistence — task completion state portability", () => {
  test("task completion state serializes and deserializes independently", () => {
    let completion = createTaskCompletionState();
    completion = markTaskComplete(completion, "re-enter-secrets");
    completion = markTaskComplete(completion, "rebind-channels");

    const json = JSON.stringify(completion);
    const restored = JSON.parse(json) as RebindTaskCompletionState;

    expect(restored["re-enter-secrets"]).toBe(true);
    expect(restored["rebind-channels"]).toBe(true);
    expect(restored["reconfigure-auth"]).toBe(false);
    expect(restored["verify-webhooks"]).toBe(false);

    // areAllRequiredTasksComplete should work on deserialized state
    expect(areAllRequiredTasksComplete(restored)).toBe(false);
  });

  test("wizard state + task completion state can be stored and restored together", () => {
    const wizardState = advanceTo("rebind-secrets");
    let completion = createTaskCompletionState();
    completion = completeOnlyRequired(completion);

    // Simulate persisting both as a combined payload
    const combined = JSON.stringify({
      wizard: JSON.parse(serializeWizardState(wizardState)),
      tasks: completion,
    });

    const parsed = JSON.parse(combined);
    const restoredWizard = deserializeWizardState(
      JSON.stringify(parsed.wizard),
    );
    const restoredTasks = parsed.tasks as RebindTaskCompletionState;

    expect(restoredWizard).toBeDefined();
    expect(restoredWizard!.currentStep).toBe("rebind-secrets");
    expect(areAllRequiredTasksComplete(restoredTasks)).toBe(true);

    // Derive screen from restored state
    const screen = deriveRebindSecretsScreenState(
      restoredWizard!,
      restoredTasks,
    );
    expect(screen.phase).toBe("active");
    if (screen.phase === "active") {
      expect(screen.allRequiredComplete).toBe(true);
    }
  });
});

describe("persistence — double serialization idempotency", () => {
  test("serializing twice produces identical output", () => {
    const state = advanceTo("transfer");
    const json1 = serializeWizardState(state);
    const restored = deserializeWizardState(json1);
    const json2 = serializeWizardState(restored!);

    // hasBundleData changes from true to false on deserialization,
    // so the second serialization will differ from the first in that field.
    const parsed1 = JSON.parse(json1);
    const parsed2 = JSON.parse(json2);
    parsed1.hasBundleData = false; // Normalize for comparison
    expect(parsed2).toEqual(parsed1);
  });

  test("prepareForResume is idempotent for non-loading, non-bundle steps", () => {
    const state = advanceTo("rebind-secrets");
    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json)!;

    const resumed1 = prepareForResume(restored);
    const resumed2 = prepareForResume(resumed1);

    // Both should be at rebind-secrets with idle status
    expect(resumed1.currentStep).toBe(resumed2.currentStep);
    expect(resumed1.steps["rebind-secrets"].status).toBe(
      resumed2.steps["rebind-secrets"].status,
    );
  });
});

// ===========================================================================
// 8. RETRY + BACK NAVIGATION AFTER PERSISTENCE
// ===========================================================================

describe("retry and back navigation after persistence round-trip", () => {
  test("can retry after restoring error state from persistence", () => {
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
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json)!;

    // Should be able to retry from restored state
    expect(canRetryCurrentStep(restored)).toBe(true);

    const reset = resetStepForRetry(restored);
    expect(reset.steps.validate.status).toBe("idle");
    expect(reset.currentStep).toBe("validate");
  });

  test("can navigate back after restoring state from persistence", () => {
    const state = advanceTo("transfer");
    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json)!;

    // Should be able to go back
    const backState = goBackTo(restored, "validate");
    expect(backState.currentStep).toBe("validate");
    expect(backState.steps.validate.status).toBe("idle");
    expect(backState.steps["preflight-review"].status).toBe("idle");
    expect(backState.steps.transfer.status).toBe("idle");
  });

  test("non-retryable error is preserved through persistence round-trip", () => {
    let state = advanceTo("validate");
    state = {
      ...state,
      steps: {
        ...state.steps,
        validate: {
          status: "error",
          error: {
            message: "Fatal: corrupted bundle",
            retryable: false,
          },
        },
      },
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json)!;

    expect(canRetryCurrentStep(restored)).toBe(false);
    expect(() => resetStepForRetry(restored)).toThrow(
      "not in a retryable error state",
    );
  });
});
