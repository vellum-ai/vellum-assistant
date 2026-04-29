/**
 * Tests for the transfer progress screen view model.
 *
 * Covers:
 * - Disabled state: screen not accessible when earlier steps incomplete
 * - Exporting state: export phase in progress
 * - Polling state: managed async export job polling
 * - Importing state: import phase in progress
 * - Success state: full import summary with details
 * - Error states: retryable vs non-retryable, failed phase inference
 * - Retry behavior: reset and re-execute after error
 * - Back navigation: return to preflight-review step
 * - Continue action: proceed to rebind-secrets step
 * - Transfer flow execution: runtime (sync) and managed (async) flows
 * - State persistence/resume: derive correct screen state after resume
 * - State change callbacks: UI reactivity during transfer
 */

import { describe, expect, test } from "bun:test";

import type {
  ExportManagedResult,
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
  completeRebindSecrets,
  createWizardState,
  deserializeWizardState,
  prepareForResume,
  selectDirection,
  serializeWizardState,
  setBundleUploaded,
} from "../runtime/migrations/migration-wizard.js";
import type { TransferScreenState } from "../runtime/migrations/transfer-progress-screen.js";
import {
  deriveTransferScreenState,
  executeTransferFlow,
  goBackToPreflight,
  isTransferScreenAccessible,
  retryTransferFlow,
} from "../runtime/migrations/transfer-progress-screen.js";

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
      contents: [{ path: "config.json", sha256: "abc123", size_bytes: 1024 }],
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
      contents: [{ path: "config.json", sha256: "abc123", size_bytes: 1024 }],
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
      importResult: makeImportSuccess(),
      currentStep: "rebind-secrets",
    };
  }
  if (targetIdx >= 6) {
    state = completeRebindSecrets(state);
  }

  return state;
}

// ---------------------------------------------------------------------------
// Disabled state
// ---------------------------------------------------------------------------

describe("deriveTransferScreenState -- disabled", () => {
  test("returns disabled when on select-direction step", () => {
    const state = createWizardState();
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("disabled");
  });

  test("returns disabled when on upload-bundle step", () => {
    const state = advanceTo("upload-bundle");
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("disabled");
  });

  test("returns disabled when on validate step", () => {
    const state = advanceTo("validate");
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("disabled");
  });

  test("returns disabled when on preflight-review step (not yet completed)", () => {
    const state = advanceTo("preflight-review");
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("disabled");
  });

  test("isTransferScreenAccessible returns false for early steps", () => {
    expect(isTransferScreenAccessible(createWizardState())).toBe(false);
  });

  test("isTransferScreenAccessible returns false for validate step", () => {
    const state = advanceTo("validate");
    expect(isTransferScreenAccessible(state)).toBe(false);
  });

  test("isTransferScreenAccessible returns true for transfer step", () => {
    const state = advanceTo("transfer");
    expect(isTransferScreenAccessible(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Importing state (default phase -- import-only flow)
// ---------------------------------------------------------------------------

describe("deriveTransferScreenState -- importing (default)", () => {
  test("shows importing when transfer step is idle (preparing)", () => {
    const state = advanceTo("transfer");
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("importing");
    if (screen.phase === "importing") {
      expect(screen.message).toContain("Importing");
    }
  });

  test("shows importing when transfer step is loading with no export result", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: { ...state.steps, transfer: { status: "loading" } },
    };
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("importing");
    if (screen.phase === "importing") {
      expect(screen.message).toContain("Importing");
    }
  });
});

// ---------------------------------------------------------------------------
// Polling state
// ---------------------------------------------------------------------------

describe("deriveTransferScreenState -- polling", () => {
  test("shows polling when managed export result exists with pending status", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: { ...state.steps, transfer: { status: "loading" } },
      exportResult: {
        ok: true,
        jobId: "exp-123",
        status: "pending",
      } as ExportManagedResult,
    };
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("polling");
    if (screen.phase === "polling") {
      expect(screen.jobId).toBe("exp-123");
      expect(screen.message).toContain("export job");
    }
  });

  test("shows polling when managed export result exists with processing status", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: { ...state.steps, transfer: { status: "loading" } },
      exportResult: {
        ok: true,
        jobId: "exp-456",
        status: "processing",
      } as ExportManagedResult,
    };
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("polling");
    if (screen.phase === "polling") {
      expect(screen.jobId).toBe("exp-456");
    }
  });
});

// ---------------------------------------------------------------------------
// Importing state
// ---------------------------------------------------------------------------

describe("deriveTransferScreenState -- importing", () => {
  test("shows importing when runtime export result exists but no import result", () => {
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
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("importing");
    if (screen.phase === "importing") {
      expect(screen.message).toContain("Importing");
    }
  });

  test("shows importing when managed export completed and import in progress", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: { ...state.steps, transfer: { status: "loading" } },
      exportResult: {
        ok: true,
        jobId: "exp-789",
        status: "complete",
      } as ExportManagedResult,
    };
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("importing");
    if (screen.phase === "importing") {
      expect(screen.message).toContain("Importing");
    }
  });
});

// ---------------------------------------------------------------------------
// Success state
// ---------------------------------------------------------------------------

describe("deriveTransferScreenState -- success", () => {
  test("shows success with import summary after transfer completes", () => {
    const state = advanceTo("rebind-secrets");
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("success");
    if (screen.phase === "success") {
      expect(screen.importSummary.totalFiles).toBe(3);
      expect(screen.importSummary.filesCreated).toBe(1);
      expect(screen.importSummary.filesOverwritten).toBe(1);
      expect(screen.importSummary.filesSkipped).toBe(1);
      expect(screen.importSummary.backupsCreated).toBe(1);
      expect(screen.importSummary.warnings).toHaveLength(1);
      expect(screen.importSummary.warnings[0]).toContain("Backup");
    }
  });

  test("canContinue is true when rebind-secrets step is accessible", () => {
    const state = advanceTo("rebind-secrets");
    const screen = deriveTransferScreenState(state);
    if (screen.phase === "success") {
      expect(screen.canContinue).toBe(true);
    }
  });

  test("success state persists when viewing from later steps", () => {
    const state = advanceTo("complete");
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("success");
  });

  test("shows success with empty summary when importResult is missing (defensive)", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: { ...state.steps, transfer: { status: "success" } },
      currentStep: "rebind-secrets",
      // No importResult
    };
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("success");
    if (screen.phase === "success") {
      expect(screen.importSummary.totalFiles).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Error states
// ---------------------------------------------------------------------------

describe("deriveTransferScreenState -- error", () => {
  test("shows error when transfer step fails with retryable error", () => {
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
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("error");
    if (screen.phase === "error") {
      expect(screen.error.message).toContain("HTTP 500");
      expect(screen.canRetry).toBe(true);
    }
  });

  test("shows error when transfer step fails with non-retryable error", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: {
        ...state.steps,
        transfer: {
          status: "error",
          error: {
            message: "import: HTTP 400",
            code: "HTTP_400",
            retryable: false,
          },
        },
      },
    };
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("error");
    if (screen.phase === "error") {
      expect(screen.canRetry).toBe(false);
    }
  });

  test("infers failed phase as import when no export result exists (import-only flow)", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: {
        ...state.steps,
        transfer: {
          status: "error",
          error: {
            message: "import: HTTP 503",
            code: "HTTP_503",
            retryable: true,
          },
        },
      },
    };
    const screen = deriveTransferScreenState(state);
    if (screen.phase === "error") {
      expect(screen.failedPhase).toBe("import");
    }
  });

  test("infers failed phase as export for EXPORT_JOB_FAILED code", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: {
        ...state.steps,
        transfer: {
          status: "error",
          error: {
            message: "Export job failed: Timeout",
            code: "EXPORT_JOB_FAILED",
            retryable: true,
          },
        },
      },
      exportResult: {
        ok: true,
        jobId: "exp-fail",
        status: "pending",
      } as ExportManagedResult,
    };
    const screen = deriveTransferScreenState(state);
    if (screen.phase === "error") {
      expect(screen.failedPhase).toBe("export");
    }
  });

  test("infers failed phase as export for NO_DOWNLOAD_URL code", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: {
        ...state.steps,
        transfer: {
          status: "error",
          error: {
            message: "Export completed but no download URL was provided",
            code: "NO_DOWNLOAD_URL",
            retryable: true,
          },
        },
      },
      exportResult: {
        ok: true,
        jobId: "exp-no-url",
        status: "complete",
      } as ExportManagedResult,
    };
    const screen = deriveTransferScreenState(state);
    if (screen.phase === "error") {
      expect(screen.failedPhase).toBe("export");
    }
  });

  test("infers failed phase as import when import result exists and failed", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: {
        ...state.steps,
        transfer: {
          status: "error",
          error: {
            message: "Disk full",
            code: "write_failed",
            retryable: true,
          },
        },
      },
      exportResult: {
        ok: true,
        filename: "export.vbundle",
        schemaVersion: 1,
        checksum: "abc",
      },
      importResult: {
        success: false,
        reason: "write_failed",
        message: "Disk full",
      },
    };
    const screen = deriveTransferScreenState(state);
    if (screen.phase === "error") {
      expect(screen.failedPhase).toBe("import");
    }
  });

  test("infers failed phase as poll for managed export transport error during download", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: {
        ...state.steps,
        transfer: {
          status: "error",
          error: {
            message: "Failed to download export: HTTP 404",
            code: "HTTP_404",
            retryable: false,
          },
        },
      },
      exportResult: {
        ok: true,
        jobId: "exp-download-fail",
        status: "complete",
      } as ExportManagedResult,
      // No importResult -- download failed before import
    };
    const screen = deriveTransferScreenState(state);
    if (screen.phase === "error") {
      expect(screen.failedPhase).toBe("poll");
    }
  });

  test("shows default error when step has error status but no error details", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: {
        ...state.steps,
        transfer: { status: "error" },
      },
    };
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("error");
    if (screen.phase === "error") {
      expect(screen.error.message).toBe("Transfer failed");
      expect(screen.error.retryable).toBe(false);
      expect(screen.canRetry).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Retry behavior
// ---------------------------------------------------------------------------

describe("retryTransferFlow", () => {
  test("retries transfer step after export error", async () => {
    let state = advanceTo("transfer");
    const importResponse = makeImportSuccess();

    // Simulate a failed export
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

    const destFetch = (async () => {
      return new Response(JSON.stringify(importResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const options = makeExecutorOptions({
      sourceConfig: runtimeConfig({ fetchFn: sourceFetch }),
      destConfig: runtimeConfig({ fetchFn: destFetch }),
    });

    const result = await retryTransferFlow(state, options);
    expect(result.steps.transfer.status).toBe("success");
    expect(result.currentStep).toBe("rebind-secrets");
  });

  test("throws when trying to retry non-retryable error", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: {
        ...state.steps,
        transfer: {
          status: "error",
          error: {
            message: "Fatal error",
            retryable: false,
          },
        },
      },
    };

    const options = makeExecutorOptions();
    expect(retryTransferFlow(state, options)).rejects.toThrow(
      "not in a retryable error state",
    );
  });

  test("emits state change on reset before retry", async () => {
    let state = advanceTo("transfer");
    const importResponse = makeImportSuccess();

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

    const destFetch = (async () => {
      return new Response(JSON.stringify(importResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const stateChanges: MigrationWizardState[] = [];
    const options = makeExecutorOptions({
      sourceConfig: runtimeConfig({ fetchFn: sourceFetch }),
      destConfig: runtimeConfig({ fetchFn: destFetch }),
      onStateChange: (s) => stateChanges.push(s),
    });

    await retryTransferFlow(state, options);

    // The first state change should be the reset (idle status)
    expect(stateChanges.length).toBeGreaterThan(0);
    expect(stateChanges[0].steps.transfer.status).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Transfer flow execution
// ---------------------------------------------------------------------------

describe("executeTransferFlow", () => {
  test("runtime export + import -- success", async () => {
    const archiveBytes = new ArrayBuffer(32);
    const importResponse = makeImportSuccess();

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

    const result = await executeTransferFlow(state, options);
    expect(result.steps.transfer.status).toBe("success");
    expect(result.currentStep).toBe("rebind-secrets");

    const screen = deriveTransferScreenState(result);
    expect(screen.phase).toBe("success");
    if (screen.phase === "success") {
      expect(screen.importSummary.totalFiles).toBe(3);
    }
  });

  test("managed export + poll + import -- success", async () => {
    let fetchCallCount = 0;
    const importResponse = makeImportSuccess();

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

    const result = await executeTransferFlow(state, options);
    expect(result.steps.transfer.status).toBe("success");
    expect(result.currentStep).toBe("rebind-secrets");
  });

  test("transfer failure sets error state with import phase", async () => {
    const state = advanceTo("transfer");
    const options = makeExecutorOptions({
      sourceConfig: runtimeConfig({ fetchFn: mockFetch(500, "Server Error") }),
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

  test("import failure sets error state with import reason", async () => {
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

    const result = await executeTransferFlow(state, options);
    expect(result.steps.transfer.status).toBe("error");
    expect(result.steps.transfer.error?.message).toContain("Disk full");
  });
});

// ---------------------------------------------------------------------------
// Back navigation
// ---------------------------------------------------------------------------

describe("goBackToPreflight", () => {
  test("navigates back to preflight-review from transfer", () => {
    const state = advanceTo("transfer");
    const result = goBackToPreflight(state);
    expect(result.currentStep).toBe("preflight-review");
    expect(result.steps.transfer.status).toBe("idle");
  });

  test("clears export and import results when going back", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      exportResult: {
        ok: true,
        filename: "export.vbundle",
        schemaVersion: 1,
        checksum: "abc",
      },
      importResult: makeImportSuccess(),
    };
    const result = goBackToPreflight(state);
    expect(result.exportResult).toBeUndefined();
    expect(result.importResult).toBeUndefined();
  });

  test("preserves validation results but clears preflight when going back", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      validateResult: makeValidateSuccess(),
      preflightResult: makePreflightSuccess(),
    };
    const result = goBackToPreflight(state);
    // Validation results are preserved since we're only going back to preflight
    expect(result.validateResult).toBeDefined();
    // Preflight results are cleared because going back resets the target step
    expect(result.preflightResult).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// State change callbacks
// ---------------------------------------------------------------------------

describe("executeTransferFlow -- onStateChange callbacks", () => {
  test("emits state changes during transfer flow", async () => {
    const archiveBytes = new ArrayBuffer(32);
    const importResponse = makeImportSuccess();

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
    const stateChanges: TransferScreenState[] = [];
    const options = makeExecutorOptions({
      sourceConfig: runtimeConfig({ fetchFn: sourceFetch }),
      destConfig: runtimeConfig({ fetchFn: destFetch }),
      onStateChange: (s) => stateChanges.push(deriveTransferScreenState(s)),
    });

    await executeTransferFlow(state, options);

    // Should have gone through at least the loading state
    const phases = stateChanges.map((s) => s.phase);
    expect(phases).toContain("importing");
  });
});

// ---------------------------------------------------------------------------
// State persistence and resume
// ---------------------------------------------------------------------------

describe("transfer screen state persistence/resume", () => {
  test("derives correct state after serialize + deserialize at transfer step", () => {
    const state = advanceTo("transfer");
    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    // After deserialization, hasBundleData is false, so prepareForResume
    // should redirect to upload-bundle
    const resumed = prepareForResume(restored!);
    const screen = deriveTransferScreenState(resumed);
    expect(screen.phase).toBe("disabled");
    expect(resumed.currentStep).toBe("upload-bundle");
  });

  test("derives correct state after resume at transfer step with loading status", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: { ...state.steps, transfer: { status: "loading" } },
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
    let state = advanceTo("rebind-secrets");
    state = {
      ...state,
      importResult: makeImportSuccess(),
    };

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    const screen = deriveTransferScreenState(restored!);
    expect(screen.phase).toBe("success");
    if (screen.phase === "success") {
      expect(screen.importSummary.totalFiles).toBe(3);
    }
  });

  test("error state is preserved after serialize/deserialize", () => {
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

    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    // The raw deserialized state (before resume) preserves the error
    const screen = deriveTransferScreenState(restored!);
    expect(screen.phase).toBe("error");
    if (screen.phase === "error") {
      expect(screen.error.message).toContain("HTTP 500");
      expect(screen.canRetry).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("transfer screen edge cases", () => {
  test("handles transfer step at complete state -- success visible", () => {
    const state = advanceTo("complete");
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("success");
  });

  test("handles transfer error from wrong step gracefully", () => {
    const state = advanceTo("validate");
    // Attempting to derive transfer screen from validate step
    const screen = deriveTransferScreenState(state);
    expect(screen.phase).toBe("disabled");
  });

  test("runtime flow does not show polling phase", async () => {
    const archiveBytes = new ArrayBuffer(32);
    const importResponse = makeImportSuccess();

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
    const stateChanges: TransferScreenState[] = [];
    const options = makeExecutorOptions({
      sourceConfig: runtimeConfig({ fetchFn: sourceFetch }),
      destConfig: runtimeConfig({ fetchFn: destFetch }),
      onStateChange: (s) => stateChanges.push(deriveTransferScreenState(s)),
    });

    await executeTransferFlow(state, options);

    // Runtime flow should not have any polling phases
    const phases = stateChanges.map((s) => s.phase);
    expect(phases).not.toContain("polling");
  });

  test("transfer flow throws when called from wrong step", async () => {
    const state = advanceTo("validate");
    const options = makeExecutorOptions();
    try {
      await executeTransferFlow(state, options);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("wrong step");
    }
  });
});
