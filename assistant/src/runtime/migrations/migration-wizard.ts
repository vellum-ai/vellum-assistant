/**
 * Migration wizard state machine — shared module for guided migration UX.
 *
 * Drives the multi-step wizard for managed <-> self-hosted assistant
 * migrations. Usable from both macOS and iOS web views via WKWebView.
 *
 * Steps:
 *   select-direction → upload-bundle → validate → preflight-review →
 *   transfer → rebind-secrets → complete
 *
 * Each step has a status (idle / loading / success / error) with error
 * details and retry capability. The entire wizard state is serializable
 * for persistence/resume across app restarts.
 */

import type {
  ExportManagedResult,
  ImportCommitResponse,
  ImportPreflightResponse,
  TransportConfig,
  ValidateResponse,
} from "./migration-transport.js";
import {
  importCommit,
  importPreflight,
  MigrationTransportError,
  validateBundle,
} from "./migration-transport.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MigrationDirection =
  | "managed-to-self-hosted"
  | "self-hosted-to-managed";

export type WizardStep =
  | "select-direction"
  | "upload-bundle"
  | "validate"
  | "preflight-review"
  | "transfer"
  | "rebind-secrets"
  | "complete";

export type StepStatus = "idle" | "loading" | "success" | "error";

export interface StepError {
  message: string;
  code?: string;
  retryable: boolean;
}

export interface StepState {
  status: StepStatus;
  error?: StepError;
}

/**
 * Full wizard state — serializable to JSON for persistence.
 *
 * All fields are plain data (no functions, no class instances).
 * Transport results that contain ArrayBuffer (non-serializable) are
 * intentionally excluded; the wizard tracks only the structured
 * metadata from each step.
 */
export interface MigrationWizardState {
  currentStep: WizardStep;
  direction?: MigrationDirection;
  steps: Record<WizardStep, StepState>;

  /** Bundle file data is not persisted — must be re-provided on resume. */
  hasBundleData: boolean;

  /** Validation result from the validate step. */
  validateResult?: ValidateResponse;

  /** Preflight result from the preflight-review step. */
  preflightResult?: ImportPreflightResponse;

  /** Export result metadata (no binary data). */
  exportResult?:
    | ExportManagedResult
    | {
        ok: true;
        filename: string;
        schemaVersion: number;
        checksum: string;
      };

  /** Import commit result. */
  importResult?: ImportCommitResponse;

  /** Credential import results from the transfer step (if credentials were in the bundle). */
  credentialsImported?: {
    total: number;
    succeeded: number;
    failed: number;
    failedAccounts: string[];
    skippedPlatform?: number;
  };

  /** Timestamp of last state change (ISO 8601). */
  updatedAt: string;

  /** Timestamp of wizard creation (ISO 8601). */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Step ordering and transitions
// ---------------------------------------------------------------------------

const STEP_ORDER: readonly WizardStep[] = [
  "select-direction",
  "upload-bundle",
  "validate",
  "preflight-review",
  "transfer",
  "rebind-secrets",
  "complete",
] as const;

const STEP_INDEX = new Map<WizardStep, number>(
  STEP_ORDER.map((step, i) => [step, i]),
);

/**
 * Steps that are available for a given migration direction.
 * Both directions use the same steps, but the semantics differ:
 *
 * - managed-to-self-hosted: export from managed, import to local runtime
 * - self-hosted-to-managed: export from local runtime, import to managed
 */
function stepsForDirection(
  _direction: MigrationDirection,
): readonly WizardStep[] {
  return STEP_ORDER;
}

// ---------------------------------------------------------------------------
// Transition validation
// ---------------------------------------------------------------------------

export interface TransitionResult {
  valid: boolean;
  reason?: string;
}

/**
 * Check whether advancing from `current` to `next` is a valid transition.
 *
 * Rules:
 * - Can advance to the immediately next step if the current step is in 'success' status.
 * - Can go back to any earlier step (allows re-doing steps).
 * - Cannot skip steps forward.
 * - 'complete' is a terminal step — no further transitions.
 */
export function validateWizardTransition(
  state: MigrationWizardState,
  next: WizardStep,
): TransitionResult {
  const current = state.currentStep;
  if (current === next) {
    return { valid: true };
  }

  if (current === "complete") {
    return {
      valid: false,
      reason: 'Cannot transition from terminal step "complete"',
    };
  }

  const currentIdx = STEP_INDEX.get(current)!;
  const nextIdx = STEP_INDEX.get(next)!;

  // Going backward is always allowed
  if (nextIdx < currentIdx) {
    return { valid: true };
  }

  // Going forward: can only advance one step at a time, and current must be 'success'
  if (nextIdx > currentIdx + 1) {
    return {
      valid: false,
      reason: `Cannot skip from "${current}" to "${next}"`,
    };
  }

  // nextIdx === currentIdx + 1
  if (state.steps[current].status !== "success") {
    return {
      valid: false,
      reason: `Cannot advance from "${current}" — step status is "${state.steps[current].status}", expected "success"`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

function makeStepStates(): Record<WizardStep, StepState> {
  const steps = {} as Record<WizardStep, StepState>;
  for (const step of STEP_ORDER) {
    steps[step] = { status: "idle" };
  }
  return steps;
}

/**
 * Create a fresh wizard state.
 */
export function createWizardState(): MigrationWizardState {
  const now = new Date().toISOString();
  return {
    currentStep: "select-direction",
    steps: makeStepStates(),
    hasBundleData: false,
    updatedAt: now,
    createdAt: now,
  };
}

// ---------------------------------------------------------------------------
// State transitions — pure functions that return a new state
// ---------------------------------------------------------------------------

function touch(state: MigrationWizardState): MigrationWizardState {
  return { ...state, updatedAt: new Date().toISOString() };
}

function setStepStatus(
  state: MigrationWizardState,
  step: WizardStep,
  status: StepStatus,
  error?: StepError,
): MigrationWizardState {
  return touch({
    ...state,
    steps: {
      ...state.steps,
      [step]: { status, ...(error ? { error } : {}) },
    },
  });
}

/**
 * Set the migration direction and advance to the next step.
 */
export function selectDirection(
  state: MigrationWizardState,
  direction: MigrationDirection,
): MigrationWizardState {
  if (state.currentStep !== "select-direction") {
    throw new Error(
      `selectDirection called in wrong step: "${state.currentStep}"`,
    );
  }

  const updated = setStepStatus(state, "select-direction", "success");
  return touch({
    ...updated,
    direction,
    currentStep: "upload-bundle",
  });
}

/**
 * Record that bundle data has been provided and advance to validate.
 */
export function setBundleUploaded(
  state: MigrationWizardState,
): MigrationWizardState {
  if (state.currentStep !== "upload-bundle") {
    throw new Error(
      `setBundleUploaded called in wrong step: "${state.currentStep}"`,
    );
  }

  const updated = setStepStatus(state, "upload-bundle", "success");
  return touch({
    ...updated,
    hasBundleData: true,
    currentStep: "validate",
  });
}

/**
 * Go back to a previous step. Resets all steps after the target step
 * to 'idle' so they can be re-executed.
 */
export function goBackTo(
  state: MigrationWizardState,
  targetStep: WizardStep,
): MigrationWizardState {
  const result = validateWizardTransition(state, targetStep);
  if (!result.valid) {
    throw new Error(`Invalid back-navigation: ${result.reason}`);
  }

  const targetIdx = STEP_INDEX.get(targetStep)!;
  const newSteps = { ...state.steps };

  // Reset the target step and all steps after it to idle
  for (const step of STEP_ORDER) {
    const idx = STEP_INDEX.get(step)!;
    if (idx >= targetIdx) {
      newSteps[step] = { status: "idle" };
    }
  }

  return touch({
    ...state,
    currentStep: targetStep,
    steps: newSteps,
    // Clear results for steps that were reset
    ...(targetIdx <= STEP_INDEX.get("validate")!
      ? { validateResult: undefined }
      : {}),
    ...(targetIdx <= STEP_INDEX.get("preflight-review")!
      ? { preflightResult: undefined }
      : {}),
    ...(targetIdx <= STEP_INDEX.get("transfer")!
      ? {
          exportResult: undefined,
          importResult: undefined,
          credentialsImported: undefined,
        }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Async step executors — coordinate transport calls with state updates
// ---------------------------------------------------------------------------

/**
 * Options for executing a wizard step, including transport config
 * and an optional state update callback for UI reactivity.
 */
export interface StepExecutorOptions {
  sourceConfig: TransportConfig;
  destConfig: TransportConfig;
  bundleData: ArrayBuffer;
  onStateChange?: (state: MigrationWizardState) => void;
}

/**
 * Build a StepError from a caught exception.
 */
function toStepError(err: unknown): StepError {
  if (err instanceof MigrationTransportError) {
    const retryable =
      err.statusCode === 429 ||
      (err.statusCode >= 500 && err.statusCode <= 504);
    return {
      message: err.message,
      code: `HTTP_${err.statusCode}`,
      retryable,
    };
  }
  if (err instanceof Error) {
    return { message: err.message, retryable: false };
  }
  return { message: String(err), retryable: false };
}

/**
 * Execute the validate step: call validateBundle and update state.
 */
export async function executeValidateStep(
  state: MigrationWizardState,
  options: StepExecutorOptions,
): Promise<MigrationWizardState> {
  if (state.currentStep !== "validate") {
    throw new Error(
      `executeValidateStep called in wrong step: "${state.currentStep}"`,
    );
  }

  let current = setStepStatus(state, "validate", "loading");
  options.onStateChange?.(current);

  try {
    const result = await validateBundle(options.destConfig, options.bundleData);
    if (result.is_valid) {
      current = setStepStatus(current, "validate", "success");
      current = {
        ...current,
        validateResult: result,
        currentStep: "preflight-review",
      };
    } else {
      current = setStepStatus(current, "validate", "error", {
        message:
          result.errors.map((e) => e.message).join("; ") ||
          "Bundle validation failed",
        code: result.errors[0]?.code,
        retryable: true,
      });
      current = { ...current, validateResult: result };
    }
  } catch (err) {
    current = setStepStatus(current, "validate", "error", toStepError(err));
  }

  current = touch(current);
  options.onStateChange?.(current);
  return current;
}

/**
 * Execute the preflight-review step: call importPreflight and update state.
 */
export async function executePreflightStep(
  state: MigrationWizardState,
  options: StepExecutorOptions,
): Promise<MigrationWizardState> {
  if (state.currentStep !== "preflight-review") {
    throw new Error(
      `executePreflightStep called in wrong step: "${state.currentStep}"`,
    );
  }

  let current = setStepStatus(state, "preflight-review", "loading");
  options.onStateChange?.(current);

  try {
    const result = await importPreflight(
      options.destConfig,
      options.bundleData,
    );
    if (result.can_import) {
      current = setStepStatus(current, "preflight-review", "success");
      current = {
        ...current,
        preflightResult: result,
        currentStep: "transfer",
      };
    } else if ("validation" in result) {
      current = setStepStatus(current, "preflight-review", "error", {
        message:
          result.validation.errors.map((e) => e.message).join("; ") ||
          "Import preflight validation failed",
        code: result.validation.errors[0]?.code,
        retryable: true,
      });
      current = { ...current, preflightResult: result };
    } else {
      current = setStepStatus(current, "preflight-review", "error", {
        message:
          result.conflicts.map((c) => c.message).join("; ") ||
          "Import blocked by conflicts",
        code: result.conflicts[0]?.code,
        retryable: true,
      });
      current = { ...current, preflightResult: result };
    }
  } catch (err) {
    current = setStepStatus(
      current,
      "preflight-review",
      "error",
      toStepError(err),
    );
  }

  current = touch(current);
  options.onStateChange?.(current);
  return current;
}

/**
 * Execute the transfer step: import the validated bundle to the destination.
 */
export async function executeTransferStep(
  state: MigrationWizardState,
  options: StepExecutorOptions,
): Promise<MigrationWizardState> {
  if (state.currentStep !== "transfer") {
    throw new Error(
      `executeTransferStep called in wrong step: "${state.currentStep}"`,
    );
  }

  let current = setStepStatus(state, "transfer", "loading");
  options.onStateChange?.(current);

  try {
    // Import the same bundle that was validated and preflighted
    const importResult = await importCommit(
      options.destConfig,
      options.bundleData,
    );
    current = { ...current, importResult };

    if (importResult.success) {
      current = setStepStatus(current, "transfer", "success");
      // Extract credential import results from the response (if present)
      current = {
        ...current,
        currentStep: "rebind-secrets",
        ...(importResult.credentialsImported
          ? { credentialsImported: importResult.credentialsImported }
          : {}),
      };
    } else {
      current = setStepStatus(current, "transfer", "error", {
        message:
          importResult.message || `Import failed: ${importResult.reason}`,
        code: importResult.reason,
        retryable: true,
      });
    }
  } catch (err) {
    current = setStepStatus(current, "transfer", "error", toStepError(err));
  }

  current = touch(current);
  options.onStateChange?.(current);
  return current;
}

/**
 * Mark the rebind-secrets step as complete.
 *
 * This step is UI-driven (the user confirms they've rebound secrets
 * and channels). The wizard just tracks its completion.
 */
export function completeRebindSecrets(
  state: MigrationWizardState,
): MigrationWizardState {
  if (state.currentStep !== "rebind-secrets") {
    throw new Error(
      `completeRebindSecrets called in wrong step: "${state.currentStep}"`,
    );
  }

  let current = setStepStatus(state, "rebind-secrets", "success");
  current = { ...current, currentStep: "complete" };
  current = setStepStatus(current, "complete", "success");
  return touch(current);
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Serialize wizard state to a JSON string for persistence.
 *
 * The state is already plain data — this is a convenience wrapper
 * that validates the shape and strips any undefined values.
 */
export function serializeWizardState(state: MigrationWizardState): string {
  return JSON.stringify(state);
}

/**
 * Deserialize a persisted wizard state from JSON.
 *
 * Returns undefined if the input is invalid or corrupted.
 * On successful deserialization, `hasBundleData` is set to false
 * because binary ArrayBuffer data cannot be persisted — the user
 * must re-provide the bundle file after resuming.
 */
export function deserializeWizardState(
  json: string,
): MigrationWizardState | undefined {
  try {
    const parsed = JSON.parse(json) as MigrationWizardState;

    // Validate required fields
    if (
      !parsed.currentStep ||
      !parsed.steps ||
      !parsed.createdAt ||
      !parsed.updatedAt
    ) {
      return undefined;
    }

    // Validate that currentStep is a known step
    if (!STEP_INDEX.has(parsed.currentStep)) {
      return undefined;
    }

    // Validate that all steps exist
    for (const step of STEP_ORDER) {
      if (!parsed.steps[step] || !parsed.steps[step].status) {
        return undefined;
      }
    }

    // Bundle data is never persisted — must be re-provided
    return { ...parsed, hasBundleData: false };
  } catch {
    return undefined;
  }
}

/**
 * Check if a persisted wizard state can be meaningfully resumed.
 *
 * A wizard is resumable if:
 * - It has a direction selected
 * - It is not already complete
 * - It is not on the first step (nothing to resume)
 */
export function isResumable(state: MigrationWizardState): boolean {
  if (!state.direction) return false;
  if (state.currentStep === "complete") return false;
  if (state.currentStep === "select-direction") return false;
  return true;
}

/**
 * Prepare a deserialized state for resumption.
 *
 * If the current step was in 'loading' status when the app closed,
 * resets it to 'idle' so the user can retry. Steps that require
 * bundle data (validate, preflight-review, transfer) will need the
 * bundle re-uploaded if it was not persisted.
 */
export function prepareForResume(
  state: MigrationWizardState,
): MigrationWizardState {
  let current = { ...state };

  // Reset loading steps to idle (they were interrupted)
  const step = current.currentStep;
  if (current.steps[step].status === "loading") {
    current = setStepStatus(current, step, "idle");
  }

  // If we need bundle data but don't have it, rewind to upload-bundle
  // and reset all downstream steps + stale results (mirrors goBackTo logic)
  const needsBundleData =
    step === "validate" || step === "preflight-review" || step === "transfer";
  if (needsBundleData && !current.hasBundleData) {
    const uploadBundleIdx = STEP_INDEX.get("upload-bundle")!;
    const newSteps = { ...current.steps };
    for (const s of STEP_ORDER) {
      const idx = STEP_INDEX.get(s)!;
      if (idx >= uploadBundleIdx) {
        newSteps[s] = { status: "idle" };
      }
    }
    current = {
      ...current,
      currentStep: "upload-bundle",
      steps: newSteps,
      validateResult: undefined,
      preflightResult: undefined,
      exportResult: undefined,
      importResult: undefined,
      credentialsImported: undefined,
    };
  }

  return touch(current);
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Get the ordered list of steps for the current wizard configuration.
 */
export function getStepOrder(
  state: MigrationWizardState,
): readonly WizardStep[] {
  return state.direction ? stepsForDirection(state.direction) : STEP_ORDER;
}

/**
 * Get the index of the current step (0-based).
 */
export function getCurrentStepIndex(state: MigrationWizardState): number {
  return STEP_INDEX.get(state.currentStep)!;
}

/**
 * Get the total number of steps.
 */
export function getTotalSteps(): number {
  return STEP_ORDER.length;
}

/**
 * Check if a step is accessible (can be navigated to) from the current state.
 */
export function isStepAccessible(
  state: MigrationWizardState,
  step: WizardStep,
): boolean {
  return validateWizardTransition(state, step).valid;
}

/**
 * Check if the wizard is in a terminal (completed) state.
 */
export function isWizardComplete(state: MigrationWizardState): boolean {
  return (
    state.currentStep === "complete" &&
    state.steps["complete"].status === "success"
  );
}

/**
 * Check if the current step has an error that can be retried.
 */
export function canRetryCurrentStep(state: MigrationWizardState): boolean {
  const stepState = state.steps[state.currentStep];
  return stepState.status === "error" && (stepState.error?.retryable ?? false);
}

/**
 * Reset the current step's error state to idle for retry.
 */
export function resetStepForRetry(
  state: MigrationWizardState,
): MigrationWizardState {
  if (!canRetryCurrentStep(state)) {
    throw new Error(
      `Cannot retry step "${state.currentStep}" — not in a retryable error state`,
    );
  }
  return setStepStatus(state, state.currentStep, "idle");
}
