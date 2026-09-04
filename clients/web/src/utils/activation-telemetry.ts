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
 * A caller whose event is emitted after work it awaits is the one exception.
 * Both seams are mutable global state that follows the active assistant, so an
 * event resolved once the work settles is tagged with whatever list the user
 * has switched to in the meantime rather than the one the action began on.
 * Those callers snapshot the pair with {@link captureActivationTelemetryContext}
 * at the start and hand it back at emit time, which overrides the resolution
 * below; synchronous callers keep using it.
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

/**
 * The arm and the list an activation action began on, for an event emitted
 * after work the user can switch assistants during.
 */
export interface ActivationTelemetryContext {
  /** The `activation-checklist` arm the client was on. */
  arm: string;
  /** The list the action belongs to, already defaulted to `"unknown"`. */
  listId: string;
}

/**
 * Snapshot the pair {@link emitActivationEvent} would resolve right now.
 *
 * `listId` may be named by a caller that already holds the list the action
 * belongs to, which is the surface's own rather than the last one a render
 * published.
 */
export function captureActivationTelemetryContext(
  listId: string = readEffectiveActivationListId() ?? "unknown",
): ActivationTelemetryContext {
  return { arm: readActivationChecklistArm(), listId };
}

export function emitActivationEvent(
  event: ActivationTelemetryEvent,
  { taskId, kind }: ActivationTelemetryDetail = {},
  context?: ActivationTelemetryContext,
): void {
  const { arm, listId } = context ?? captureActivationTelemetryContext();
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
      variant: arm,
    },
  );
}
