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

/**
 * Model-facing activation-moment tokens. These are the values the model passes
 * as the optional `ui_show` `activation_moment` tag; the daemon maps each token
 * to its `ACTIVATION_STEPS[...].stepName` and records the milestone when the
 * tagged surface is committed. Kept short/stable so the schema enum is friendly
 * for the model — the canonical wire vocabulary stays `ActivationStepName`.
 */
export type ActivationMomentParam =
  | "moment_1"
  | "moment_2"
  | "moment_3"
  | "first_wow_executed"
  | "first_wow_interacted";

/**
 * `ActivationMomentParam` token → canonical `ActivationStepName`, derived from
 * `ACTIVATION_STEPS` so the vocabulary stays single-sourced. The token order
 * mirrors `ACTIVATION_STEPS` (indices 1–5).
 */
const STEP_NAME_BY_MOMENT_PARAM = {
  moment_1: ACTIVATION_STEPS.moment1.stepName,
  moment_2: ACTIVATION_STEPS.moment2.stepName,
  moment_3: ACTIVATION_STEPS.moment3.stepName,
  first_wow_executed: ACTIVATION_STEPS.firstWowExecuted.stepName,
  first_wow_interacted: ACTIVATION_STEPS.firstWowInteracted.stepName,
} as const satisfies Record<ActivationMomentParam, ActivationStepName>;

/** The five valid model-facing moment tokens (e.g. for a schema enum). */
export const ACTIVATION_MOMENT_PARAMS = Object.keys(
  STEP_NAME_BY_MOMENT_PARAM,
) as ActivationMomentParam[];

/** Type guard: is `value` one of the model-facing activation-moment tokens? */
export function isActivationMomentParam(
  value: string,
): value is ActivationMomentParam {
  return Object.prototype.hasOwnProperty.call(STEP_NAME_BY_MOMENT_PARAM, value);
}

/** Map a model-facing moment token to its canonical activation step name. */
export function activationStepNameForMomentParam(
  param: ActivationMomentParam,
): ActivationStepName {
  return STEP_NAME_BY_MOMENT_PARAM[param];
}

/**
 * When each tagged moment is emitted relative to its `ui_show` surface:
 * - `"show"` — at surface render time. `first_wow_executed` is an *execution*
 *   signal: the rail's result/`work_result` surface is display-only and may
 *   receive no user commit, so a commit-time emit would never fire (and if the
 *   card has an action, deferring to the click would conflate "executed" with
 *   "interacted" and corrupt funnel timing).
 * - `"commit"` — on user commit/interaction. The other four moments represent
 *   resolving an intake, picking an offer/task, or clicking a result action —
 *   all genuine commit events.
 */
export const ACTIVATION_MOMENT_EMIT_AT = {
  moment_1: "commit",
  moment_2: "commit",
  moment_3: "commit",
  first_wow_executed: "show",
  first_wow_interacted: "commit",
} as const satisfies Record<ActivationMomentParam, "show" | "commit">;

/** True when the moment records at surface-render time rather than on commit. */
export function activationMomentEmitsAtShow(
  param: ActivationMomentParam,
): boolean {
  return ACTIVATION_MOMENT_EMIT_AT[param] === "show";
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
