/**
 * Telemetry for the activation checklist, riding the existing onboarding
 * funnel pipeline: same event shape, ingest path, and analytics-consent gating
 * (`readShareAnalytics()` inside the base emitter). Each event lands with
 * `funnel_version: "activation_checklist_v1_2026_09"`, `screen` = the list id
 * the user is on (so a funnel can be split per persona), `variant` = the flag
 * arm, and `step_name` = the action taken.
 *
 * The arm and the list are resolved here rather than passed in. Every call
 * site was reading the same two values off the same two seams, which is four
 * chances for one of them to tag an event with a list the user is not on; what
 * a call site actually knows is which task or which surface, and that is all
 * it hands over.
 *
 * Lives beside `tips-telemetry.ts` rather than inside the activation domain
 * for the same reason that one does: the funnel emitter belongs to the
 * onboarding domain, and a domain module may not reach across to another.
 */

import { emitOnboardingFunnelStepCompleted } from "@/domains/onboarding/funnel-events";
import { readActivationChecklistArm } from "@/hooks/use-activation-checklist-flag";
import { readEffectiveActivationListId } from "@/hooks/use-activation-enabled";

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

export interface ActivationTelemetryDetail {
  /** Task id, for the two task-scoped events. */
  taskId?: string;
  /**
   * Which surface was closed, for the dismissal. The welcome modal defers the
   * checklist and the celebration retires it, and only one of those is a user
   * saying no.
   */
  kind?: "modal" | "all-done";
}

export function emitActivationEvent(
  event: ActivationTelemetryEvent,
  { taskId, kind }: ActivationTelemetryDetail = {},
): void {
  const listId = readEffectiveActivationListId() ?? "unknown";
  const qualifier = taskId ?? kind;
  emitOnboardingFunnelStepCompleted(
    { stepName: event, stepIndex: EVENT_STEP_INDICES[event] },
    {
      funnelVersion: ACTIVATION_FUNNEL_VERSION,
      // The list a task belongs to is the dimension every funnel is split by,
      // so it rides `screen`; an event scoped to a task or a surface qualifies
      // it with that, the same dimension-in-`screen` pattern the tips and tour
      // funnels use.
      screen: qualifier ? `${listId}/${qualifier}` : listId,
      variant: readActivationChecklistArm(),
    },
  );
}
