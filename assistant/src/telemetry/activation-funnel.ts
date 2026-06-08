/**
 * Activation funnel vocabulary — the single source of truth for the
 * activation-rail telemetry funnel.
 *
 * The activation rail emits milestone ("funnel") events into the existing
 * onboarding telemetry substrate (`type: "onboarding"`). This module defines
 * the step vocabulary (step_name → step_index), the funnel version, the
 * cohort arm tag, and the deterministic `daemon_event_id` used for dbt-side
 * dedup. Downstream PRs (store, reporter, emit handler, turn hook) import
 * from here so the vocabulary is never duplicated.
 */

/** Funnel version stamped on every activation event (per JARVIS-1033). */
export const ACTIVATION_FUNNEL_VERSION = "activation_v1_2026_06";

/**
 * Filename of the bootstrap template that drives the activation rail. The web
 * prechat-context sets this as `onboardingContext.bootstrapTemplate` (mirrored
 * there as `ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE`); the daemon recognizes it to
 * mark the conversation as an activation session. Single source of truth on the
 * daemon side so the literal isn't duplicated across modules.
 */
export const ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE =
  "BOOTSTRAP-ACTIVATION-RAIL.md";

/**
 * Cohort arm tag for Stream-A emission. The daemon only runs the rail for
 * treatment users, so activation events are tagged with the treatment arm
 * name ("variant-a"), mirroring `pre-chat-onboarding-experiment-2026-06-06`.
 * Stream B later threads the assigned arm in place of this constant.
 */
export const ACTIVATION_AB_VARIANT = "variant-a";

/**
 * Activation funnel steps keyed by short id. `stepName` is the wire value
 * sent to telemetry; `stepIndex` is the 1-based ordinal position. This is
 * the single source of truth for the step vocabulary.
 */
export const ACTIVATION_STEPS = {
  moment1: { stepName: "activation_moment_1_complete", stepIndex: 1 },
  moment2: { stepName: "activation_moment_2_complete", stepIndex: 2 },
  moment3: { stepName: "activation_moment_3_complete", stepIndex: 3 },
  firstWowExecuted: { stepName: "activation_first_wow_executed", stepIndex: 4 },
  firstWowInteracted: {
    stepName: "activation_first_wow_interacted",
    stepIndex: 5,
  },
} as const;

/** Union of valid activation step names. */
export type ActivationStepName =
  (typeof ACTIVATION_STEPS)[keyof typeof ACTIVATION_STEPS]["stepName"];

/** step_name → step_index, derived once from the vocabulary. */
const STEP_INDEX_BY_NAME = new Map<ActivationStepName, number>(
  Object.values(ACTIVATION_STEPS).map((step) => [
    step.stepName,
    step.stepIndex,
  ]),
);

/** Type guard: is `value` one of the known activation step names? */
export function isActivationStepName(
  value: string,
): value is ActivationStepName {
  return STEP_INDEX_BY_NAME.has(value as ActivationStepName);
}

/** Look up the 1-based funnel index for a step name. */
export function activationStepIndex(stepName: ActivationStepName): number {
  // Non-null: ActivationStepName is derived from ACTIVATION_STEPS, so the map
  // always contains the key.
  return STEP_INDEX_BY_NAME.get(stepName)!;
}

/**
 * Deterministic `daemon_event_id` for an activation event. Keying on
 * `${funnel_version}:${sessionId}:${stepName}` lets the existing dbt
 * dedup (keyed on `daemon_event_id`, earliest-wins) collapse a moment that
 * fires more than once into a single row.
 *
 * `funnelVersion` defaults to the current `ACTIVATION_FUNNEL_VERSION` but
 * callers that have a per-row stored version (e.g. the telemetry reporter
 * flushing rows recorded under an older version) MUST pass the row's own
 * `funnel_version` so the id stays stable across a version bump — otherwise
 * queued/offline v1 rows would be keyed with the new binary's version and
 * stop collapsing with already-ingested v1 rows from the same session.
 */
export function buildActivationDaemonEventId(
  sessionId: string,
  stepName: ActivationStepName,
  funnelVersion: string = ACTIVATION_FUNNEL_VERSION,
): string {
  return `${funnelVersion}:${sessionId}:${stepName}`;
}
