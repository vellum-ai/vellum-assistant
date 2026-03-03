/**
 * Transfer progress screen -- view model for the transfer step.
 *
 * Derives display state from the migration wizard state machine for rendering
 * a transfer/import progress UI. Usable from macOS/iOS web views, CLI, or
 * any TypeScript consumer.
 *
 * The transfer step involves two phases:
 *   1. Export -- export data from the source (runtime: synchronous, managed: async with polling)
 *   2. Import -- commit the exported bundle to the destination
 *
 * View model states:
 *   - disabled: step is not yet accessible (earlier steps incomplete)
 *   - exporting: export phase is in progress
 *   - polling: managed async export job is being polled for completion
 *   - importing: import phase is in progress (export completed, importing bundle)
 *   - success: both export and import completed successfully
 *   - error: an error occurred (with retry capability info)
 */

import type {
  ExportManagedResult,
  ImportCommitSuccessResponse,
} from "./migration-transport.js";
import type {
  MigrationWizardState,
  StepError,
  StepExecutorOptions,
} from "./migration-wizard.js";
import {
  canRetryCurrentStep,
  executeTransferStep,
  goBackTo,
  isStepAccessible,
  resetStepForRetry,
} from "./migration-wizard.js";

// ---------------------------------------------------------------------------
// View model types
// ---------------------------------------------------------------------------

/** Which phase of the transfer is currently active. */
export type TransferPhase = "export" | "poll" | "import";

/** Summary of the import result for display. */
export interface TransferImportSummary {
  totalFiles: number;
  filesCreated: number;
  filesOverwritten: number;
  filesSkipped: number;
  backupsCreated: number;
  warnings: string[];
}

/**
 * Discriminated union representing the current display state of the
 * transfer progress screen.
 */
export type TransferScreenState =
  | { phase: "disabled" }
  | { phase: "exporting"; message: string }
  | { phase: "polling"; message: string; jobId: string }
  | { phase: "importing"; message: string }
  | {
      phase: "error";
      error: StepError;
      /** Which transfer phase failed, if determinable. */
      failedPhase: TransferPhase | "unknown";
      canRetry: boolean;
    }
  | {
      phase: "success";
      importSummary: TransferImportSummary;
      canContinue: boolean;
    };

// ---------------------------------------------------------------------------
// State derivation
// ---------------------------------------------------------------------------

/**
 * Infer which transfer sub-phase is active based on wizard state.
 *
 * Heuristic:
 * - If exportResult exists and has a jobId (managed) but no importResult,
 *   we are in the polling/download phase.
 * - If exportResult exists (runtime or managed complete) but no importResult,
 *   we are in the import phase.
 * - Otherwise we are in the export phase.
 */
function inferActivePhase(state: MigrationWizardState): TransferPhase {
  if (!state.exportResult) {
    return "export";
  }

  // Managed export that may still be polling
  if ("jobId" in state.exportResult) {
    const managed = state.exportResult as ExportManagedResult;
    // If we have an importResult, polling is done and import has started/finished
    if (state.importResult) {
      return "import";
    }
    // Still in polling/export phase
    if (managed.status !== "complete") {
      return "poll";
    }
  }

  // Export is done; if no import result yet, we are importing
  if (!state.importResult) {
    return "import";
  }

  return "import";
}

/**
 * Infer the phase that failed when the transfer step is in error state.
 */
function inferFailedPhase(
  state: MigrationWizardState,
): TransferPhase | "unknown" {
  const stepError = state.steps["transfer"].error;
  if (!stepError) return "unknown";

  // Export job failure codes
  if (
    stepError.code === "EXPORT_JOB_FAILED" ||
    stepError.code === "NO_DOWNLOAD_URL"
  ) {
    return "export";
  }

  // If we have no export result, the export itself failed
  if (!state.exportResult) {
    return "export";
  }

  // If we have an export result but the error mentions import
  if (state.importResult && !state.importResult.success) {
    return "import";
  }

  // If export result exists but no import result, and error is transport-level,
  // it could be download failure or import failure
  if (state.exportResult && !state.importResult) {
    // If it's a managed export and we have no import result, it could be polling or download
    if ("jobId" in state.exportResult) {
      return "poll";
    }
    return "import";
  }

  return "unknown";
}

/**
 * Derive the current transfer screen state from the wizard state.
 *
 * This is a pure function -- no side effects. Call it whenever the wizard
 * state changes to get the latest display state.
 */
export function deriveTransferScreenState(
  wizardState: MigrationWizardState,
): TransferScreenState {
  const transferStep = wizardState.steps["transfer"];

  // Not yet accessible -- earlier steps incomplete
  if (
    wizardState.currentStep !== "transfer" &&
    transferStep.status !== "success"
  ) {
    if (!isStepAccessible(wizardState, "transfer")) {
      return { phase: "disabled" };
    }
  }

  // Transfer step is in error state
  if (
    wizardState.currentStep === "transfer" &&
    transferStep.status === "error"
  ) {
    return {
      phase: "error",
      error: transferStep.error ?? {
        message: "Transfer failed",
        retryable: false,
      },
      failedPhase: inferFailedPhase(wizardState),
      canRetry: canRetryCurrentStep(wizardState),
    };
  }

  // Transfer step is loading -- determine sub-phase
  if (
    wizardState.currentStep === "transfer" &&
    (transferStep.status === "loading" || transferStep.status === "idle")
  ) {
    const activePhase = inferActivePhase(wizardState);

    if (
      activePhase === "poll" &&
      wizardState.exportResult &&
      "jobId" in wizardState.exportResult
    ) {
      return {
        phase: "polling",
        message: "Waiting for export job to complete...",
        jobId: (wizardState.exportResult as ExportManagedResult).jobId,
      };
    }

    if (activePhase === "import") {
      return {
        phase: "importing",
        message: "Importing bundle to destination...",
      };
    }

    // Default: export phase
    return {
      phase: "exporting",
      message: "Exporting data from source...",
    };
  }

  // Transfer step succeeded -- show results
  if (transferStep.status === "success") {
    const importResult = wizardState.importResult;
    if (importResult && importResult.success) {
      const successResult = importResult as ImportCommitSuccessResponse;
      return {
        phase: "success",
        importSummary: {
          totalFiles: successResult.summary.total_files,
          filesCreated: successResult.summary.files_created,
          filesOverwritten: successResult.summary.files_overwritten,
          filesSkipped: successResult.summary.files_skipped,
          backupsCreated: successResult.summary.backups_created,
          warnings: successResult.warnings,
        },
        canContinue: isStepAccessible(wizardState, "rebind-secrets"),
      };
    }

    // Success status but no import result (shouldn't happen, defensive)
    return {
      phase: "success",
      importSummary: {
        totalFiles: 0,
        filesCreated: 0,
        filesOverwritten: 0,
        filesSkipped: 0,
        backupsCreated: 0,
        warnings: [],
      },
      canContinue: isStepAccessible(wizardState, "rebind-secrets"),
    };
  }

  return { phase: "disabled" };
}

// ---------------------------------------------------------------------------
// Actions -- delegate to wizard state machine
// ---------------------------------------------------------------------------

/**
 * Execute the full transfer flow: export from source and import to destination.
 *
 * For managed sources, this includes async export polling.
 * For runtime sources, the export returns binary data directly.
 *
 * Returns the final wizard state after the transfer step completes.
 */
export async function executeTransferFlow(
  state: MigrationWizardState,
  options: StepExecutorOptions,
): Promise<MigrationWizardState> {
  return executeTransferStep(state, options);
}

/**
 * Retry the transfer step after an error.
 *
 * Resets the step to idle and re-executes the transfer flow.
 */
export async function retryTransferFlow(
  state: MigrationWizardState,
  options: StepExecutorOptions,
): Promise<MigrationWizardState> {
  const reset = resetStepForRetry(state);
  options.onStateChange?.(reset);
  return executeTransferStep(reset, options);
}

/**
 * Navigate back to the preflight-review step.
 */
export function goBackToPreflight(
  state: MigrationWizardState,
): MigrationWizardState {
  return goBackTo(state, "preflight-review");
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Check if the transfer progress screen is accessible from the current state.
 */
export function isTransferScreenAccessible(
  state: MigrationWizardState,
): boolean {
  return (
    isStepAccessible(state, "transfer") || state.currentStep === "transfer"
  );
}
