/**
 * Transfer progress screen -- view model for the transfer step.
 *
 * Derives display state from the migration wizard state machine for rendering
 * a transfer/import progress UI. Usable from macOS/iOS web views, CLI, or
 * any TypeScript consumer.
 *
 * The transfer step is import-only: it commits a pre-uploaded bundle to
 * the destination. The export/poll phases are retained in the type system
 * for managed-source flows that still use them, but the default phase is
 * "import".
 *
 * View model states:
 *   - disabled: step is not yet accessible (earlier steps incomplete)
 *   - exporting: export phase is in progress (managed-source flows only)
 *   - polling: managed async export job is being polled for completion
 *   - importing: import phase is in progress
 *   - success: import completed successfully
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
 * The default flow is import-only (bundleData provided directly). Managed
 * export flows that populate exportResult still get poll/export phases.
 */
function inferActivePhase(state: MigrationWizardState): TransferPhase {
  // Managed export flows that populate exportResult
  if (state.exportResult && "jobId" in state.exportResult) {
    const managed = state.exportResult as ExportManagedResult;
    if (state.importResult) {
      return "import";
    }
    if (managed.status !== "complete") {
      return "poll";
    }
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

  // No exportResult means this is the import-only flow; attribute to import
  if (!state.exportResult) {
    return "import";
  }

  // If we have an export result but the error mentions import
  if (state.importResult && !state.importResult.success) {
    return "import";
  }

  // If export result exists but no import result, and error is transport-level,
  // it could be download failure or import failure
  if (state.exportResult && !state.importResult) {
    if ("jobId" in state.exportResult) {
      const managed = state.exportResult as ExportManagedResult;
      if (managed.status === "complete") {
        // Export completed but no importResult -- check whether the failure was
        // during archive download (between export and import) or during import.
        // Download failures surface with "download" in the message; actual
        // import failures would have set importResult.
        const msg = stepError.message?.toLowerCase() ?? "";
        if (msg.includes("download")) {
          return "poll";
        }
        return "import";
      }
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

    if (activePhase === "export") {
      return {
        phase: "exporting",
        message: "Exporting data from source...",
      };
    }

    // Default: import phase
    return {
      phase: "importing",
      message: "Importing bundle to destination...",
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
  const cleaned = {
    ...reset,
    importResult: undefined,
  };
  options.onStateChange?.(cleaned);
  return executeTransferStep(cleaned, options);
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
