/**
 * Rebind secrets screen -- view model for the rebind-secrets step.
 *
 * Derives display state from the migration wizard state machine for rendering
 * a post-migration task checklist UI. Usable from macOS/iOS web views, CLI,
 * or any TypeScript consumer.
 *
 * After a successful transfer, secrets (API keys, tokens) are redacted in
 * exported bundles and communication channels (Slack, Telegram, etc.) need
 * to be re-bound to the new instance. This screen presents a checklist of
 * tasks the operator must complete before the migration is considered done.
 *
 * View model states:
 *   - disabled: step is not yet accessible (earlier steps incomplete)
 *   - active: checklist is displayed with tasks to complete
 *   - complete: all required tasks are done, migration can be finalized
 *
 * Task categories:
 *   - re-enter-secrets: Re-enter API keys/secrets (redacted in bundles)
 *   - rebind-channels: Re-bind communication channels (Slack, Telegram, etc.)
 *   - reconfigure-auth: Re-configure identity/auth settings
 *   - verify-webhooks: Verify webhook URLs point to new instance
 *
 * Operator notes:
 *   Setup: Ensure the destination instance is running and reachable before
 *     starting the checklist. Secrets must be re-entered manually since
 *     they are never included in export bundles.
 *   Rollback: If a task cannot be completed, navigate back to transfer
 *     to re-import the bundle or start a new migration.
 *   Expected signals: Each task toggles between pending/complete. The
 *     "Complete Migration" action is only available when all required
 *     tasks are marked complete.
 */

import type { MigrationWizardState } from "./migration-wizard.js";
import {
  completeRebindSecrets,
  goBackTo,
  isStepAccessible,
} from "./migration-wizard.js";

// ---------------------------------------------------------------------------
// View model types
// ---------------------------------------------------------------------------

/** Unique identifier for each rebind task. */
export type RebindTaskId =
  | "re-enter-secrets"
  | "rebind-channels"
  | "reconfigure-auth"
  | "verify-webhooks";

/** Status of an individual checklist task. */
export type RebindTaskStatus = "pending" | "complete";

/** A single task in the rebind checklist. */
export interface RebindTask {
  id: RebindTaskId;
  title: string;
  description: string;
  status: RebindTaskStatus;
  required: boolean;
  helpText?: string;
}

/** Snapshot of which tasks have been marked complete. */
export type RebindTaskCompletionState = Record<RebindTaskId, boolean>;

/**
 * Discriminated union representing the current display state of the
 * rebind secrets screen.
 */
export type RebindSecretsScreenState =
  | { phase: "disabled" }
  | {
      phase: "active";
      tasks: RebindTask[];
      allRequiredComplete: boolean;
      completedCount: number;
      totalCount: number;
      requiredCount: number;
      requiredCompletedCount: number;
    }
  | {
      phase: "complete";
      tasks: RebindTask[];
    };

// ---------------------------------------------------------------------------
// Task definitions
// ---------------------------------------------------------------------------

interface TaskDefinition {
  id: RebindTaskId;
  title: string;
  description: string;
  required: boolean;
  helpText?: string;
}

const TASK_DEFINITIONS: readonly TaskDefinition[] = [
  {
    id: "re-enter-secrets",
    title: "Re-enter API keys and secrets",
    description:
      "Secrets are redacted in export bundles for security. Re-enter all API keys, tokens, and credentials in the destination instance.",
    required: true,
    helpText:
      "Navigate to Settings > Integrations to re-enter provider API keys (e.g., Anthropic, OpenAI). Check Settings > Secrets for any custom secrets used by skills.",
  },
  {
    id: "rebind-channels",
    title: "Re-bind communication channels",
    description:
      "Communication channel bindings (Slack, Telegram, etc.) are instance-specific. Re-configure each channel to point to the new instance.",
    required: true,
    helpText:
      "For Slack: re-install the Slack app in your workspace. For Telegram: update the bot webhook URL.",
  },
  {
    id: "reconfigure-auth",
    title: "Re-configure identity and auth settings",
    description:
      "Authentication settings, OAuth tokens, and identity provider configurations may need to be re-established on the new instance.",
    required: true,
    helpText:
      "Check guardian settings, OAuth app registrations, and any SSO configurations. Re-authorize connected services if needed.",
  },
  {
    id: "verify-webhooks",
    title: "Verify webhook URLs",
    description:
      "Ensure all webhook URLs registered with external services point to the new instance's public ingress URL.",
    required: false,
    helpText:
      "Review the public ingress URL in Settings > Gateway. Update any external services (GitHub, calendar providers, etc.) that send webhooks to this assistant.",
  },
] as const;

// ---------------------------------------------------------------------------
// Task completion state management
// ---------------------------------------------------------------------------

/**
 * Create a fresh task completion state with all tasks pending.
 */
export function createTaskCompletionState(): RebindTaskCompletionState {
  const state = {} as RebindTaskCompletionState;
  for (const def of TASK_DEFINITIONS) {
    state[def.id] = false;
  }
  return state;
}

/**
 * Toggle a task's completion status.
 *
 * Returns a new state object (immutable update).
 */
export function toggleTaskCompletion(
  state: RebindTaskCompletionState,
  taskId: RebindTaskId,
): RebindTaskCompletionState {
  return { ...state, [taskId]: !state[taskId] };
}

/**
 * Mark a specific task as complete.
 *
 * Returns a new state object (immutable update).
 */
export function markTaskComplete(
  state: RebindTaskCompletionState,
  taskId: RebindTaskId,
): RebindTaskCompletionState {
  return { ...state, [taskId]: true };
}

/**
 * Mark a specific task as pending (incomplete).
 *
 * Returns a new state object (immutable update).
 */
export function markTaskPending(
  state: RebindTaskCompletionState,
  taskId: RebindTaskId,
): RebindTaskCompletionState {
  return { ...state, [taskId]: false };
}

// ---------------------------------------------------------------------------
// State derivation
// ---------------------------------------------------------------------------

/**
 * Build the task list from definitions and completion state.
 */
function buildTasks(completionState: RebindTaskCompletionState): RebindTask[] {
  return TASK_DEFINITIONS.map((def) => ({
    id: def.id,
    title: def.title,
    description: def.description,
    status: completionState[def.id]
      ? ("complete" as const)
      : ("pending" as const),
    required: def.required,
    ...(def.helpText !== undefined ? { helpText: def.helpText } : {}),
  }));
}

/**
 * Check whether all required tasks are complete.
 */
export function areAllRequiredTasksComplete(
  completionState: RebindTaskCompletionState,
): boolean {
  return TASK_DEFINITIONS.filter((d) => d.required).every(
    (d) => completionState[d.id],
  );
}

/**
 * Derive the current rebind secrets screen state from the wizard state
 * and the local task completion state.
 *
 * This is a pure function -- no side effects. Call it whenever the wizard
 * state or task completion state changes to get the latest display state.
 *
 * The `completionState` parameter tracks which tasks the operator has
 * marked complete. It is managed separately from the wizard state because
 * individual task toggles are a UI concern, not a wizard transition.
 */
export function deriveRebindSecretsScreenState(
  wizardState: MigrationWizardState,
  completionState: RebindTaskCompletionState,
): RebindSecretsScreenState {
  const rebindStep = wizardState.steps["rebind-secrets"];

  // Not yet accessible -- earlier steps incomplete
  if (
    wizardState.currentStep !== "rebind-secrets" &&
    rebindStep.status !== "success"
  ) {
    if (!isStepAccessible(wizardState, "rebind-secrets")) {
      return { phase: "disabled" };
    }
  }

  // Already completed (viewing from a later step or after completion)
  if (rebindStep.status === "success") {
    const tasks = buildTasks(completionState);
    return { phase: "complete", tasks };
  }

  // Active -- show the checklist
  if (wizardState.currentStep === "rebind-secrets") {
    const tasks = buildTasks(completionState);
    const requiredTasks = tasks.filter((t) => t.required);
    const completedTasks = tasks.filter((t) => t.status === "complete");
    const requiredCompletedTasks = requiredTasks.filter(
      (t) => t.status === "complete",
    );

    return {
      phase: "active",
      tasks,
      allRequiredComplete: areAllRequiredTasksComplete(completionState),
      completedCount: completedTasks.length,
      totalCount: tasks.length,
      requiredCount: requiredTasks.length,
      requiredCompletedCount: requiredCompletedTasks.length,
    };
  }

  return { phase: "disabled" };
}

// ---------------------------------------------------------------------------
// Actions -- delegate to wizard state machine
// ---------------------------------------------------------------------------

/**
 * Complete the rebind-secrets step and advance to the complete step.
 *
 * This should only be called when all required tasks are marked complete.
 * Throws if called when required tasks are incomplete.
 */
export function completeMigration(
  wizardState: MigrationWizardState,
  completionState: RebindTaskCompletionState,
): MigrationWizardState {
  if (!areAllRequiredTasksComplete(completionState)) {
    throw new Error(
      "Cannot complete migration: not all required tasks are done",
    );
  }
  return completeRebindSecrets(wizardState);
}

/**
 * Navigate back to the transfer step and reset the rebind checklist.
 *
 * Returns both the rewound wizard state and a fresh completion state so
 * callers clear stale task progress from a previous transfer attempt.
 */
export function goBackToTransfer(state: MigrationWizardState): {
  wizardState: MigrationWizardState;
  completionState: RebindTaskCompletionState;
} {
  return {
    wizardState: goBackTo(state, "transfer"),
    completionState: createTaskCompletionState(),
  };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Check if the rebind secrets screen is accessible from the current state.
 */
export function isRebindSecretsScreenAccessible(
  state: MigrationWizardState,
): boolean {
  return (
    isStepAccessible(state, "rebind-secrets") ||
    state.currentStep === "rebind-secrets"
  );
}

/**
 * Get the list of all task IDs in display order.
 */
export function getTaskIds(): readonly RebindTaskId[] {
  return TASK_DEFINITIONS.map((d) => d.id);
}

/**
 * Get the count of required tasks.
 */
export function getRequiredTaskCount(): number {
  return TASK_DEFINITIONS.filter((d) => d.required).length;
}

/**
 * Get the count of total tasks.
 */
export function getTotalTaskCount(): number {
  return TASK_DEFINITIONS.length;
}
