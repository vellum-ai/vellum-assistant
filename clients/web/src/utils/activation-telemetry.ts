/**
 * Telemetry for the activation checklist, riding the existing onboarding
 * funnel pipeline: same event shape, ingest path, and analytics-consent gating
 * (`readShareAnalytics()` inside the base emitter). Each event lands with
 * `funnel_version: "activation_checklist_v1_2026_09"`, `screen` = the list id
 * the user is on (so a funnel can be split per persona), `variant` = the flag
 * arm, and `step_name` = the action taken.
 *
 * Lives beside `tips-telemetry.ts` rather than inside the activation domain
 * for the same reason that one does: the funnel emitter belongs to the
 * onboarding domain, and a domain module may not reach across to another.
 */

import { emitOnboardingFunnelStepCompleted } from "@/domains/onboarding/funnel-events";

const ACTIVATION_FUNNEL_VERSION = "activation_checklist_v1_2026_09";

export type ActivationTelemetryEvent =
  | "activation_modal_shown"
  | "activation_modal_dismissed"
  | "activation_task_started"
  | "activation_task_completed"
  | "activation_pill_clicked"
  | "activation_list_opened";

/**
 * Step indices order the funnel in the analytics UI. They are stable: a new
 * event takes the next free index rather than renumbering the existing ones,
 * which would split every historical funnel.
 */
const EVENT_STEP_INDICES: Record<ActivationTelemetryEvent, number> = {
  activation_modal_shown: 0,
  activation_task_started: 1,
  activation_task_completed: 2,
  activation_modal_dismissed: 3,
  activation_pill_clicked: 4,
  activation_list_opened: 5,
};

export interface ActivationTelemetryContext {
  /** The `activation-checklist` flag arm this client is on. */
  arm: string;
  /** The effective list id, or null before progress has frozen one. */
  listId: string | null;
  /** Task id, for the two task-scoped events. */
  taskId?: string;
}

export function emitActivationEvent(
  event: ActivationTelemetryEvent,
  { arm, listId, taskId }: ActivationTelemetryContext,
): void {
  emitOnboardingFunnelStepCompleted(
    { stepName: event, stepIndex: EVENT_STEP_INDICES[event] },
    {
      funnelVersion: ACTIVATION_FUNNEL_VERSION,
      // The list a task belongs to is the dimension every funnel is split by,
      // so it rides `screen`; a task-scoped event qualifies it with the id,
      // the same dimension-in-`screen` pattern the tips and tour funnels use.
      screen: taskId ? `${listId ?? "unknown"}/${taskId}` : (listId ?? "unknown"),
      variant: arm,
    },
  );
}
