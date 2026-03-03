/**
 * Validation results screen — view model for the validate + preflight-review steps.
 *
 * Derives display state from the migration wizard state machine for rendering
 * a validation results and dry-run summary UI. Usable from macOS/iOS web views,
 * CLI, or any TypeScript consumer.
 *
 * The screen combines two wizard steps into one logical view:
 *   1. validate — bundle integrity and schema validation
 *   2. preflight-review — dry-run import analysis (what would change)
 *
 * View model states:
 *   - disabled: step is not yet accessible (earlier steps incomplete)
 *   - loading: validation or preflight analysis is in progress
 *   - validation-error: bundle validation failed with errors
 *   - preflight-error: preflight analysis failed
 *   - transport-error: network/HTTP error occurred
 *   - success: both validation and preflight passed, ready to proceed
 */

import type {
  ImportPreflightConflict,
  ImportPreflightFileReport,
  ImportPreflightSuccessResponse,
  ValidateSuccessResponse,
  ValidationError,
} from "./migration-transport.js";
import type {
  MigrationWizardState,
  StepError,
  StepExecutorOptions,
} from "./migration-wizard.js";
import {
  canRetryCurrentStep,
  executePreflightStep,
  executeValidateStep,
  goBackTo,
  isStepAccessible,
  resetStepForRetry,
} from "./migration-wizard.js";

// ---------------------------------------------------------------------------
// View model types
// ---------------------------------------------------------------------------

/** Summary counts for the preflight dry-run analysis. */
export interface PreflightSummary {
  totalFiles: number;
  filesToCreate: number;
  filesToOverwrite: number;
  filesUnchanged: number;
}

/** A file entry in the preflight analysis, normalized for display. */
export interface PreflightFileEntry {
  path: string;
  action: "create" | "overwrite" | "unchanged";
  bundleSize: number;
  currentSize: number | null;
  bundleSha256: string;
  currentSha256: string | null;
}

/** A conflict detected during preflight analysis. */
export interface PreflightConflictEntry {
  code: string;
  message: string;
  path?: string;
}

/**
 * Discriminated union representing the current display state of the
 * validation results screen.
 */
export type ValidationScreenState =
  | { phase: "disabled" }
  | { phase: "loading"; message: string }
  | {
      phase: "validation-error";
      errors: ValidationError[];
      canRetry: boolean;
    }
  | {
      phase: "preflight-error";
      error: StepError;
      canRetry: boolean;
    }
  | {
      phase: "transport-error";
      error: StepError;
      step: "validate" | "preflight-review";
      canRetry: boolean;
    }
  | {
      phase: "success";
      validation: {
        isValid: true;
        manifest: ValidateSuccessResponse["manifest"];
      };
      preflight: {
        summary: PreflightSummary;
        files: PreflightFileEntry[];
        conflicts: PreflightConflictEntry[];
        manifest: ImportPreflightSuccessResponse["manifest"];
      };
      canContinue: boolean;
    };

// ---------------------------------------------------------------------------
// State derivation
// ---------------------------------------------------------------------------

/**
 * Normalize an ImportPreflightFileReport to a display-friendly shape.
 */
function normalizeFileReport(
  report: ImportPreflightFileReport,
): PreflightFileEntry {
  return {
    path: report.path,
    action: report.action,
    bundleSize: report.bundle_size,
    currentSize: report.current_size,
    bundleSha256: report.bundle_sha256,
    currentSha256: report.current_sha256,
  };
}

/**
 * Normalize an ImportPreflightConflict to a display-friendly shape.
 */
function normalizeConflict(
  conflict: ImportPreflightConflict,
): PreflightConflictEntry {
  return {
    code: conflict.code,
    message: conflict.message,
    ...(conflict.path !== undefined ? { path: conflict.path } : {}),
  };
}

/**
 * Derive the current validation screen state from the wizard state.
 *
 * This is a pure function — no side effects. Call it whenever the wizard
 * state changes to get the latest display state.
 */
export function deriveValidationScreenState(
  wizardState: MigrationWizardState,
): ValidationScreenState {
  const validateStep = wizardState.steps["validate"];
  const preflightStep = wizardState.steps["preflight-review"];

  // Check if the validate step is accessible at all
  if (
    !isStepAccessible(wizardState, "validate") &&
    wizardState.currentStep !== "validate" &&
    wizardState.currentStep !== "preflight-review"
  ) {
    // Also check if we're past these steps (success case from later steps)
    if (
      validateStep.status !== "success" ||
      preflightStep.status !== "success"
    ) {
      return { phase: "disabled" };
    }
  }

  // Validate step is loading
  if (
    wizardState.currentStep === "validate" &&
    validateStep.status === "loading"
  ) {
    return { phase: "loading", message: "Validating bundle..." };
  }

  // Preflight step is loading
  if (
    wizardState.currentStep === "preflight-review" &&
    preflightStep.status === "loading"
  ) {
    return { phase: "loading", message: "Analyzing import changes..." };
  }

  // Validate step idle (not yet started)
  if (
    wizardState.currentStep === "validate" &&
    validateStep.status === "idle"
  ) {
    return { phase: "loading", message: "Preparing validation..." };
  }

  // Preflight step idle (not yet started, validation passed)
  if (
    wizardState.currentStep === "preflight-review" &&
    preflightStep.status === "idle"
  ) {
    return { phase: "loading", message: "Preparing import analysis..." };
  }

  // Validate step errored
  if (
    wizardState.currentStep === "validate" &&
    validateStep.status === "error"
  ) {
    // Check if this is a validation failure (bundle invalid) vs transport error
    if (wizardState.validateResult && !wizardState.validateResult.is_valid) {
      return {
        phase: "validation-error",
        errors: wizardState.validateResult.errors,
        canRetry: canRetryCurrentStep(wizardState),
      };
    }

    // Transport/network error
    return {
      phase: "transport-error",
      error: validateStep.error ?? {
        message: "Validation failed",
        retryable: false,
      },
      step: "validate",
      canRetry: canRetryCurrentStep(wizardState),
    };
  }

  // Preflight step errored
  if (
    wizardState.currentStep === "preflight-review" &&
    preflightStep.status === "error"
  ) {
    // Check if this is a preflight validation failure vs transport error
    if (
      wizardState.preflightResult &&
      !wizardState.preflightResult.can_import
    ) {
      return {
        phase: "preflight-error",
        error: preflightStep.error ?? {
          message: "Import preflight validation failed",
          retryable: false,
        },
        canRetry: canRetryCurrentStep(wizardState),
      };
    }

    // Transport/network error
    return {
      phase: "transport-error",
      error: preflightStep.error ?? {
        message: "Preflight analysis failed",
        retryable: false,
      },
      step: "preflight-review",
      canRetry: canRetryCurrentStep(wizardState),
    };
  }

  // Both steps succeeded — show full results
  if (
    validateStep.status === "success" &&
    preflightStep.status === "success" &&
    wizardState.validateResult?.is_valid &&
    wizardState.preflightResult?.can_import
  ) {
    const validateResult =
      wizardState.validateResult as ValidateSuccessResponse;
    const preflightResult =
      wizardState.preflightResult as ImportPreflightSuccessResponse;

    return {
      phase: "success",
      validation: {
        isValid: true,
        manifest: validateResult.manifest,
      },
      preflight: {
        summary: {
          totalFiles: preflightResult.summary.total_files,
          filesToCreate: preflightResult.summary.files_to_create,
          filesToOverwrite: preflightResult.summary.files_to_overwrite,
          filesUnchanged: preflightResult.summary.files_unchanged,
        },
        files: preflightResult.files.map(normalizeFileReport),
        conflicts: preflightResult.conflicts.map(normalizeConflict),
        manifest: preflightResult.manifest,
      },
      canContinue: isStepAccessible(wizardState, "transfer"),
    };
  }

  // Fallback: if we're on a step past preflight-review and both succeeded,
  // still show success (viewing results from a later step)
  if (validateStep.status === "success" && preflightStep.status === "success") {
    const validateResult = wizardState.validateResult;
    const preflightResult = wizardState.preflightResult;

    if (validateResult?.is_valid && preflightResult?.can_import) {
      const vr = validateResult as ValidateSuccessResponse;
      const pr = preflightResult as ImportPreflightSuccessResponse;

      return {
        phase: "success",
        validation: {
          isValid: true,
          manifest: vr.manifest,
        },
        preflight: {
          summary: {
            totalFiles: pr.summary.total_files,
            filesToCreate: pr.summary.files_to_create,
            filesToOverwrite: pr.summary.files_to_overwrite,
            filesUnchanged: pr.summary.files_unchanged,
          },
          files: pr.files.map(normalizeFileReport),
          conflicts: pr.conflicts.map(normalizeConflict),
          manifest: pr.manifest,
        },
        canContinue: isStepAccessible(wizardState, "transfer"),
      };
    }
  }

  return { phase: "disabled" };
}

// ---------------------------------------------------------------------------
// Actions — delegate to wizard state machine
// ---------------------------------------------------------------------------

/**
 * Execute both the validate and preflight steps in sequence.
 *
 * Runs validation first; if it succeeds, automatically proceeds to
 * preflight analysis. Returns the final wizard state after both steps.
 */
export async function executeValidationFlow(
  state: MigrationWizardState,
  options: StepExecutorOptions,
): Promise<MigrationWizardState> {
  // Run validation
  let current = await executeValidateStep(state, options);

  // If validation succeeded, the wizard advances to preflight-review.
  // Automatically run the preflight step.
  if (
    current.currentStep === "preflight-review" &&
    current.steps["validate"].status === "success"
  ) {
    current = await executePreflightStep(current, options);
  }

  return current;
}

/**
 * Retry the current step after an error.
 *
 * Resets the step to idle and re-executes the appropriate step.
 * If the validate step is retried and succeeds, automatically
 * proceeds to the preflight step.
 */
export async function retryValidationFlow(
  state: MigrationWizardState,
  options: StepExecutorOptions,
): Promise<MigrationWizardState> {
  let reset = resetStepForRetry(state);

  // Clear stale results so a new transport error isn't misclassified
  // as a validation/preflight failure based on the previous attempt's result.
  if (reset.currentStep === "validate") {
    reset = { ...reset, validateResult: undefined };
  } else if (reset.currentStep === "preflight-review") {
    reset = { ...reset, preflightResult: undefined };
  }

  options.onStateChange?.(reset);

  if (reset.currentStep === "validate") {
    return executeValidationFlow(reset, options);
  }

  if (reset.currentStep === "preflight-review") {
    return executePreflightStep(reset, options);
  }

  throw new Error(
    `Cannot retry validation flow from step "${reset.currentStep}"`,
  );
}

/**
 * Navigate back to the upload-bundle step.
 */
export function goBackToUpload(
  state: MigrationWizardState,
): MigrationWizardState {
  return goBackTo(state, "upload-bundle");
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Check if the validation results screen is accessible from the current state.
 */
export function isValidationScreenAccessible(
  state: MigrationWizardState,
): boolean {
  return (
    isStepAccessible(state, "validate") ||
    state.currentStep === "validate" ||
    state.currentStep === "preflight-review"
  );
}

/**
 * Get the file entries grouped by action for display.
 */
export function groupFilesByAction(files: PreflightFileEntry[]): {
  create: PreflightFileEntry[];
  overwrite: PreflightFileEntry[];
  unchanged: PreflightFileEntry[];
} {
  const create: PreflightFileEntry[] = [];
  const overwrite: PreflightFileEntry[] = [];
  const unchanged: PreflightFileEntry[] = [];

  for (const file of files) {
    switch (file.action) {
      case "create":
        create.push(file);
        break;
      case "overwrite":
        overwrite.push(file);
        break;
      case "unchanged":
        unchanged.push(file);
        break;
    }
  }

  return { create, overwrite, unchanged };
}

/**
 * Format a byte size as a human-readable string.
 */
export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, exponent);
  return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}
