/**
 * Tests for the rebind secrets screen view model.
 *
 * Covers:
 * - Disabled state: screen not accessible when earlier steps incomplete
 * - Active state: checklist displayed with tasks and progress tracking
 * - Complete state: all required tasks done, migration finalized
 * - Task management: toggle, mark complete, mark pending
 * - Task completion state: fresh state, required task gating
 * - Complete migration action: requires all required tasks, delegates to wizard
 * - Back navigation: return to transfer step
 * - Non-skippable tasks: required tasks prevent completion when pending
 * - Query helpers: accessibility, task IDs, counts
 * - State persistence/resume: derive correct screen state after resume
 * - Task definitions: correct metadata for all tasks
 */

import { describe, expect, test } from "bun:test";

import type {
  ImportCommitResponse,
  ImportPreflightResponse,
  ValidateResponse,
} from "../runtime/migrations/migration-transport.js";
import type {
  MigrationWizardState,
  WizardStep,
} from "../runtime/migrations/migration-wizard.js";
import {
  completeRebindSecrets,
  createWizardState,
  deserializeWizardState,
  isWizardComplete,
  prepareForResume,
  selectDirection,
  serializeWizardState,
  setBundleUploaded,
} from "../runtime/migrations/migration-wizard.js";
import type { RebindTaskCompletionState } from "../runtime/migrations/rebind-secrets-screen.js";
import {
  areAllRequiredTasksComplete,
  completeMigration,
  createTaskCompletionState,
  deriveRebindSecretsScreenState,
  getRequiredTaskCount,
  getTaskIds,
  getTotalTaskCount,
  goBackToTransfer,
  isRebindSecretsScreenAccessible,
  markTaskComplete,
  markTaskPending,
  toggleTaskCompletion,
} from "../runtime/migrations/rebind-secrets-screen.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

/** Mark all required tasks as complete. */
function completeAllRequired(
  state: RebindTaskCompletionState,
): RebindTaskCompletionState {
  let current = state;
  const taskIds = getTaskIds();
  for (const id of taskIds) {
    // We need to know which are required -- use the screen to check
    // For simplicity, mark all tasks complete
    current = markTaskComplete(current, id);
  }
  return current;
}

/** Mark only the required tasks as complete (re-enter-secrets, rebind-channels, reconfigure-auth). */
function completeOnlyRequired(
  state: RebindTaskCompletionState,
): RebindTaskCompletionState {
  let current = state;
  current = markTaskComplete(current, "re-enter-secrets");
  current = markTaskComplete(current, "rebind-channels");
  current = markTaskComplete(current, "reconfigure-auth");
  return current;
}

// ---------------------------------------------------------------------------
// Disabled state
// ---------------------------------------------------------------------------

describe("deriveRebindSecretsScreenState -- disabled", () => {
  test("returns disabled when on select-direction step", () => {
    const state = createWizardState();
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(state, completion);
    expect(screen.phase).toBe("disabled");
  });

  test("returns disabled when on upload-bundle step", () => {
    const state = advanceTo("upload-bundle");
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(state, completion);
    expect(screen.phase).toBe("disabled");
  });

  test("returns disabled when on validate step", () => {
    const state = advanceTo("validate");
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(state, completion);
    expect(screen.phase).toBe("disabled");
  });

  test("returns disabled when on preflight-review step", () => {
    const state = advanceTo("preflight-review");
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(state, completion);
    expect(screen.phase).toBe("disabled");
  });

  test("returns disabled when on transfer step (not yet completed)", () => {
    const state = advanceTo("transfer");
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(state, completion);
    expect(screen.phase).toBe("disabled");
  });

  test("isRebindSecretsScreenAccessible returns false for early steps", () => {
    expect(isRebindSecretsScreenAccessible(createWizardState())).toBe(false);
  });

  test("isRebindSecretsScreenAccessible returns false for transfer step", () => {
    const state = advanceTo("transfer");
    expect(isRebindSecretsScreenAccessible(state)).toBe(false);
  });

  test("isRebindSecretsScreenAccessible returns true for rebind-secrets step", () => {
    const state = advanceTo("rebind-secrets");
    expect(isRebindSecretsScreenAccessible(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Active state
// ---------------------------------------------------------------------------

describe("deriveRebindSecretsScreenState -- active", () => {
  test("shows active with all tasks pending when first entering step", () => {
    const state = advanceTo("rebind-secrets");
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(state, completion);
    expect(screen.phase).toBe("active");
    if (screen.phase === "active") {
      expect(screen.tasks).toHaveLength(4);
      expect(screen.completedCount).toBe(0);
      expect(screen.totalCount).toBe(4);
      expect(screen.allRequiredComplete).toBe(false);
    }
  });

  test("tracks required task counts correctly", () => {
    const state = advanceTo("rebind-secrets");
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(state, completion);
    if (screen.phase === "active") {
      expect(screen.requiredCount).toBe(3);
      expect(screen.requiredCompletedCount).toBe(0);
    }
  });

  test("updates progress when tasks are completed", () => {
    const state = advanceTo("rebind-secrets");
    let completion = createTaskCompletionState();
    completion = markTaskComplete(completion, "re-enter-secrets");
    completion = markTaskComplete(completion, "rebind-channels");

    const screen = deriveRebindSecretsScreenState(state, completion);
    if (screen.phase === "active") {
      expect(screen.completedCount).toBe(2);
      expect(screen.requiredCompletedCount).toBe(2);
      expect(screen.allRequiredComplete).toBe(false);
    }
  });

  test("allRequiredComplete is true when all required tasks are done", () => {
    const state = advanceTo("rebind-secrets");
    const completion = completeOnlyRequired(createTaskCompletionState());

    const screen = deriveRebindSecretsScreenState(state, completion);
    if (screen.phase === "active") {
      expect(screen.allRequiredComplete).toBe(true);
      expect(screen.requiredCompletedCount).toBe(3);
      // Optional task (verify-webhooks) is still pending
      expect(screen.completedCount).toBe(3);
    }
  });

  test("allRequiredComplete is true even when optional tasks are pending", () => {
    const state = advanceTo("rebind-secrets");
    const completion = completeOnlyRequired(createTaskCompletionState());

    const screen = deriveRebindSecretsScreenState(state, completion);
    if (screen.phase === "active") {
      expect(screen.allRequiredComplete).toBe(true);
      // verify-webhooks is optional and still pending
      const webhookTask = screen.tasks.find((t) => t.id === "verify-webhooks");
      expect(webhookTask?.status).toBe("pending");
      expect(webhookTask?.required).toBe(false);
    }
  });

  test("each task has correct metadata", () => {
    const state = advanceTo("rebind-secrets");
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(state, completion);
    if (screen.phase === "active") {
      const secretsTask = screen.tasks.find((t) => t.id === "re-enter-secrets");
      expect(secretsTask).toBeDefined();
      expect(secretsTask!.title).toContain("API keys");
      expect(secretsTask!.description).toContain("redacted");
      expect(secretsTask!.required).toBe(true);
      expect(secretsTask!.helpText).toBeDefined();

      const channelsTask = screen.tasks.find((t) => t.id === "rebind-channels");
      expect(channelsTask).toBeDefined();
      expect(channelsTask!.title).toContain("communication channels");
      expect(channelsTask!.required).toBe(true);

      const authTask = screen.tasks.find((t) => t.id === "reconfigure-auth");
      expect(authTask).toBeDefined();
      expect(authTask!.title).toContain("identity");
      expect(authTask!.required).toBe(true);

      const webhookTask = screen.tasks.find((t) => t.id === "verify-webhooks");
      expect(webhookTask).toBeDefined();
      expect(webhookTask!.title).toContain("webhook");
      expect(webhookTask!.required).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Complete state
// ---------------------------------------------------------------------------

describe("deriveRebindSecretsScreenState -- complete", () => {
  test("shows complete after wizard rebind-secrets step succeeds", () => {
    const state = advanceTo("complete");
    const completion = completeAllRequired(createTaskCompletionState());
    const screen = deriveRebindSecretsScreenState(state, completion);
    expect(screen.phase).toBe("complete");
    if (screen.phase === "complete") {
      expect(screen.tasks).toHaveLength(4);
    }
  });

  test("complete state includes task statuses from completion state", () => {
    const state = advanceTo("complete");
    const completion = completeAllRequired(createTaskCompletionState());
    const screen = deriveRebindSecretsScreenState(state, completion);
    if (screen.phase === "complete") {
      const allComplete = screen.tasks.every((t) => t.status === "complete");
      expect(allComplete).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Task completion state management
// ---------------------------------------------------------------------------

describe("createTaskCompletionState", () => {
  test("creates state with all tasks pending", () => {
    const state = createTaskCompletionState();
    expect(state["re-enter-secrets"]).toBe(false);
    expect(state["rebind-channels"]).toBe(false);
    expect(state["reconfigure-auth"]).toBe(false);
    expect(state["verify-webhooks"]).toBe(false);
  });
});

describe("toggleTaskCompletion", () => {
  test("toggles a pending task to complete", () => {
    const state = createTaskCompletionState();
    const updated = toggleTaskCompletion(state, "re-enter-secrets");
    expect(updated["re-enter-secrets"]).toBe(true);
    // Other tasks unchanged
    expect(updated["rebind-channels"]).toBe(false);
  });

  test("toggles a complete task back to pending", () => {
    let state = createTaskCompletionState();
    state = markTaskComplete(state, "re-enter-secrets");
    const updated = toggleTaskCompletion(state, "re-enter-secrets");
    expect(updated["re-enter-secrets"]).toBe(false);
  });

  test("returns a new object (immutable)", () => {
    const state = createTaskCompletionState();
    const updated = toggleTaskCompletion(state, "re-enter-secrets");
    expect(updated).not.toBe(state);
    expect(state["re-enter-secrets"]).toBe(false);
  });
});

describe("markTaskComplete", () => {
  test("marks a task as complete", () => {
    const state = createTaskCompletionState();
    const updated = markTaskComplete(state, "rebind-channels");
    expect(updated["rebind-channels"]).toBe(true);
  });

  test("is idempotent for already-complete tasks", () => {
    let state = createTaskCompletionState();
    state = markTaskComplete(state, "rebind-channels");
    const updated = markTaskComplete(state, "rebind-channels");
    expect(updated["rebind-channels"]).toBe(true);
  });
});

describe("markTaskPending", () => {
  test("marks a complete task as pending", () => {
    let state = createTaskCompletionState();
    state = markTaskComplete(state, "reconfigure-auth");
    const updated = markTaskPending(state, "reconfigure-auth");
    expect(updated["reconfigure-auth"]).toBe(false);
  });

  test("is idempotent for already-pending tasks", () => {
    const state = createTaskCompletionState();
    const updated = markTaskPending(state, "reconfigure-auth");
    expect(updated["reconfigure-auth"]).toBe(false);
  });
});

describe("areAllRequiredTasksComplete", () => {
  test("returns false when no tasks are complete", () => {
    const state = createTaskCompletionState();
    expect(areAllRequiredTasksComplete(state)).toBe(false);
  });

  test("returns false when only some required tasks are complete", () => {
    let state = createTaskCompletionState();
    state = markTaskComplete(state, "re-enter-secrets");
    state = markTaskComplete(state, "rebind-channels");
    expect(areAllRequiredTasksComplete(state)).toBe(false);
  });

  test("returns true when all required tasks are complete", () => {
    const state = completeOnlyRequired(createTaskCompletionState());
    expect(areAllRequiredTasksComplete(state)).toBe(true);
  });

  test("returns true when all tasks (including optional) are complete", () => {
    const state = completeAllRequired(createTaskCompletionState());
    expect(areAllRequiredTasksComplete(state)).toBe(true);
  });

  test("ignores optional tasks when checking required completion", () => {
    let state = createTaskCompletionState();
    // Complete only the optional task
    state = markTaskComplete(state, "verify-webhooks");
    expect(areAllRequiredTasksComplete(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Complete migration action
// ---------------------------------------------------------------------------

describe("completeMigration", () => {
  test("advances wizard to complete when all required tasks are done", () => {
    const wizardState = advanceTo("rebind-secrets");
    const completion = completeOnlyRequired(createTaskCompletionState());

    const result = completeMigration(wizardState, completion);
    expect(result.currentStep).toBe("complete");
    expect(result.steps["rebind-secrets"].status).toBe("success");
    expect(result.steps["complete"].status).toBe("success");
    expect(isWizardComplete(result)).toBe(true);
  });

  test("throws when required tasks are incomplete", () => {
    const wizardState = advanceTo("rebind-secrets");
    const completion = createTaskCompletionState();

    expect(() => completeMigration(wizardState, completion)).toThrow(
      "not all required tasks are done",
    );
  });

  test("throws when only optional tasks are complete", () => {
    const wizardState = advanceTo("rebind-secrets");
    let completion = createTaskCompletionState();
    completion = markTaskComplete(completion, "verify-webhooks");

    expect(() => completeMigration(wizardState, completion)).toThrow(
      "not all required tasks are done",
    );
  });

  test("throws when called from wrong wizard step", () => {
    const wizardState = advanceTo("transfer");
    const completion = completeAllRequired(createTaskCompletionState());

    expect(() => completeMigration(wizardState, completion)).toThrow(
      "wrong step",
    );
  });

  test("succeeds with all tasks complete (including optional)", () => {
    const wizardState = advanceTo("rebind-secrets");
    const completion = completeAllRequired(createTaskCompletionState());

    const result = completeMigration(wizardState, completion);
    expect(result.currentStep).toBe("complete");
    expect(isWizardComplete(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Back navigation
// ---------------------------------------------------------------------------

describe("goBackToTransfer", () => {
  test("navigates back to transfer from rebind-secrets", () => {
    const state = advanceTo("rebind-secrets");
    const { wizardState } = goBackToTransfer(state);
    expect(wizardState.currentStep).toBe("transfer");
    expect(wizardState.steps["rebind-secrets"].status).toBe("idle");
  });

  test("clears export and import results when going back to transfer", () => {
    let state = advanceTo("rebind-secrets");
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
    const { wizardState } = goBackToTransfer(state);
    expect(wizardState.exportResult).toBeUndefined();
    expect(wizardState.importResult).toBeUndefined();
  });

  test("preserves validation and preflight results when going back to transfer", () => {
    let state = advanceTo("rebind-secrets");
    state = {
      ...state,
      validateResult: makeValidateSuccess(),
      preflightResult: makePreflightSuccess(),
    };
    const { wizardState } = goBackToTransfer(state);
    expect(wizardState.validateResult).toBeDefined();
    expect(wizardState.preflightResult).toBeDefined();
  });

  test("resets task completion state when going back to transfer", () => {
    const state = advanceTo("rebind-secrets");
    const { completionState } = goBackToTransfer(state);
    const taskIds = getTaskIds();
    for (const id of taskIds) {
      expect(completionState[id]).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Non-skippable task enforcement
// ---------------------------------------------------------------------------

describe("non-skippable required tasks", () => {
  test("cannot complete migration with re-enter-secrets pending", () => {
    const wizardState = advanceTo("rebind-secrets");
    let completion = createTaskCompletionState();
    completion = markTaskComplete(completion, "rebind-channels");
    completion = markTaskComplete(completion, "reconfigure-auth");
    // re-enter-secrets is still pending

    expect(() => completeMigration(wizardState, completion)).toThrow(
      "not all required tasks are done",
    );
  });

  test("cannot complete migration with rebind-channels pending", () => {
    const wizardState = advanceTo("rebind-secrets");
    let completion = createTaskCompletionState();
    completion = markTaskComplete(completion, "re-enter-secrets");
    completion = markTaskComplete(completion, "reconfigure-auth");
    // rebind-channels is still pending

    expect(() => completeMigration(wizardState, completion)).toThrow(
      "not all required tasks are done",
    );
  });

  test("cannot complete migration with reconfigure-auth pending", () => {
    const wizardState = advanceTo("rebind-secrets");
    let completion = createTaskCompletionState();
    completion = markTaskComplete(completion, "re-enter-secrets");
    completion = markTaskComplete(completion, "rebind-channels");
    // reconfigure-auth is still pending

    expect(() => completeMigration(wizardState, completion)).toThrow(
      "not all required tasks are done",
    );
  });

  test("can complete migration with verify-webhooks (optional) pending", () => {
    const wizardState = advanceTo("rebind-secrets");
    const completion = completeOnlyRequired(createTaskCompletionState());
    // verify-webhooks is still pending, but it's optional

    const result = completeMigration(wizardState, completion);
    expect(result.currentStep).toBe("complete");
  });

  test("allRequiredComplete in screen state correctly gates completion", () => {
    const wizardState = advanceTo("rebind-secrets");

    // No tasks complete
    const screen1 = deriveRebindSecretsScreenState(
      wizardState,
      createTaskCompletionState(),
    );
    if (screen1.phase === "active") {
      expect(screen1.allRequiredComplete).toBe(false);
    }

    // Some required tasks complete
    let partial = createTaskCompletionState();
    partial = markTaskComplete(partial, "re-enter-secrets");
    const screen2 = deriveRebindSecretsScreenState(wizardState, partial);
    if (screen2.phase === "active") {
      expect(screen2.allRequiredComplete).toBe(false);
    }

    // All required complete
    const allReq = completeOnlyRequired(createTaskCompletionState());
    const screen3 = deriveRebindSecretsScreenState(wizardState, allReq);
    if (screen3.phase === "active") {
      expect(screen3.allRequiredComplete).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

describe("query helpers", () => {
  test("getTaskIds returns all task IDs in order", () => {
    const ids = getTaskIds();
    expect(ids).toEqual([
      "re-enter-secrets",
      "rebind-channels",
      "reconfigure-auth",
      "verify-webhooks",
    ]);
  });

  test("getRequiredTaskCount returns count of required tasks", () => {
    expect(getRequiredTaskCount()).toBe(3);
  });

  test("getTotalTaskCount returns total task count", () => {
    expect(getTotalTaskCount()).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// State persistence and resume
// ---------------------------------------------------------------------------

describe("rebind secrets screen state persistence/resume", () => {
  test("derives correct state after serialize + deserialize at rebind-secrets step", () => {
    const state = advanceTo("rebind-secrets");
    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(restored!, completion);
    expect(screen.phase).toBe("active");
    if (screen.phase === "active") {
      expect(screen.tasks).toHaveLength(4);
      expect(screen.completedCount).toBe(0);
    }
  });

  test("derives correct state after resume at rebind-secrets step", () => {
    const state = advanceTo("rebind-secrets");
    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    // prepareForResume does not redirect rebind-secrets (no bundle data needed)
    const resumed = prepareForResume(restored!);
    expect(resumed.currentStep).toBe("rebind-secrets");

    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(resumed, completion);
    expect(screen.phase).toBe("active");
  });

  test("complete state persists across serialize/deserialize", () => {
    const state = advanceTo("complete");
    const json = serializeWizardState(state);
    const restored = deserializeWizardState(json);
    expect(restored).toBeDefined();

    const completion = completeAllRequired(createTaskCompletionState());
    const screen = deriveRebindSecretsScreenState(restored!, completion);
    expect(screen.phase).toBe("complete");
  });

  test("task completion state is independently serializable", () => {
    let completion = createTaskCompletionState();
    completion = markTaskComplete(completion, "re-enter-secrets");
    completion = markTaskComplete(completion, "rebind-channels");

    const json = JSON.stringify(completion);
    const restored = JSON.parse(json) as RebindTaskCompletionState;

    expect(restored["re-enter-secrets"]).toBe(true);
    expect(restored["rebind-channels"]).toBe(true);
    expect(restored["reconfigure-auth"]).toBe(false);
    expect(restored["verify-webhooks"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("rebind secrets screen edge cases", () => {
  test("handles rebind-secrets step at complete state -- complete visible", () => {
    const state = advanceTo("complete");
    const completion = completeAllRequired(createTaskCompletionState());
    const screen = deriveRebindSecretsScreenState(state, completion);
    expect(screen.phase).toBe("complete");
  });

  test("returns disabled when transfer step has error", () => {
    let state = advanceTo("transfer");
    state = {
      ...state,
      steps: {
        ...state.steps,
        transfer: {
          status: "error",
          error: { message: "Transfer failed", retryable: true },
        },
      },
    };
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(state, completion);
    expect(screen.phase).toBe("disabled");
  });

  test("toggling tasks does not modify original state", () => {
    const original = createTaskCompletionState();
    const modified = toggleTaskCompletion(original, "re-enter-secrets");

    expect(original["re-enter-secrets"]).toBe(false);
    expect(modified["re-enter-secrets"]).toBe(true);
  });

  test("screen reflects toggled task status correctly", () => {
    const wizardState = advanceTo("rebind-secrets");
    let completion = createTaskCompletionState();

    // Toggle re-enter-secrets on
    completion = toggleTaskCompletion(completion, "re-enter-secrets");
    let screen = deriveRebindSecretsScreenState(wizardState, completion);
    if (screen.phase === "active") {
      const task = screen.tasks.find((t) => t.id === "re-enter-secrets");
      expect(task?.status).toBe("complete");
    }

    // Toggle re-enter-secrets off
    completion = toggleTaskCompletion(completion, "re-enter-secrets");
    screen = deriveRebindSecretsScreenState(wizardState, completion);
    if (screen.phase === "active") {
      const task = screen.tasks.find((t) => t.id === "re-enter-secrets");
      expect(task?.status).toBe("pending");
    }
  });

  test("all tasks have non-empty title and description", () => {
    const wizardState = advanceTo("rebind-secrets");
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(wizardState, completion);
    if (screen.phase === "active") {
      for (const task of screen.tasks) {
        expect(task.title.length).toBeGreaterThan(0);
        expect(task.description.length).toBeGreaterThan(0);
      }
    }
  });

  test("all tasks have help text", () => {
    const wizardState = advanceTo("rebind-secrets");
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(wizardState, completion);
    if (screen.phase === "active") {
      for (const task of screen.tasks) {
        expect(task.helpText).toBeDefined();
        expect(task.helpText!.length).toBeGreaterThan(0);
      }
    }
  });
});
