import { readShareAnalytics } from "@/domains/onboarding/prefs";
import { postTelemetryEvents } from "@/lib/telemetry/ingest";
import type { ResearchStep } from "@/domains/onboarding/research-onboarding-persistence";

export const ONBOARDING_FUNNEL_VERSION = "onboarding_v3_2026_05";
const SESSION_STORAGE_KEY = "onboarding.funnelSessionId";
const VARIANT_STORAGE_KEY = "onboarding.funnelVariant";

export const ONBOARDING_FUNNEL_VARIANTS = {
  control: "control",
  paredDown: "pared_down",
} as const;

export type OnboardingFunnelVariant =
  (typeof ONBOARDING_FUNNEL_VARIANTS)[keyof typeof ONBOARDING_FUNNEL_VARIANTS];

export function onboardingFunnelVariantFromExperiment(
  experimentArm: string,
): OnboardingFunnelVariant {
  return experimentArm === "variant-a"
    ? ONBOARDING_FUNNEL_VARIANTS.paredDown
    : ONBOARDING_FUNNEL_VARIANTS.control;
}

export const ONBOARDING_FUNNEL_STEPS = {
  privacyTos: { stepName: "privacy_tos", stepIndex: 0 },
  nameVibe: { stepName: "name_vibe", stepIndex: 1 },
  controlWorkType: { stepName: "work_type", stepIndex: 2 },
  controlTools: { stepName: "tools", stepIndex: 3 },
  controlPriorAssistants: { stepName: "prior_assistants", stepIndex: 4 },
  controlGmailConnect: { stepName: "gmail_connect", stepIndex: 5 },
  controlGetApp: { stepName: "get_app", stepIndex: 6 },
  gmailConnect: { stepName: "gmail_connect", stepIndex: 2 },
} as const;

export type OnboardingFunnelStep =
  (typeof ONBOARDING_FUNNEL_STEPS)[keyof typeof ONBOARDING_FUNNEL_STEPS];

export type OnboardingFunnelStepName = OnboardingFunnelStep["stepName"];

/**
 * Structural shape every funnel step descriptor satisfies. Lets the emit/build
 * helpers serve multiple funnels (the pre-chat funnel and the research-onboarding
 * funnel below) without pinning the step-name union to one funnel's steps.
 */
export interface OnboardingFunnelStepDescriptor {
  stepName: string;
  stepIndex: number;
}

/**
 * Research-onboarding funnel. A distinct funnel from the pre-chat one above — its
 * own version string and step names — but it rides the same telemetry event shape
 * and ingest path. The backend stores step_name/funnel_version as open strings, so
 * these new values need no backend/terraform change.
 */
export const RESEARCH_ONBOARDING_FUNNEL_VERSION =
  "research_onboarding_v1_2026_06";

export const RESEARCH_ONBOARDING_FUNNEL_STEPS = {
  form: { stepName: "research_form", stepIndex: 0 },
  face: { stepName: "research_face", stepIndex: 1 },
  intro: { stepName: "research_intro", stepIndex: 2 },
  different: { stepName: "research_pitch", stepIndex: 3 },
  personality: { stepName: "research_personality", stepIndex: 4 },
  integration: { stepName: "research_integration", stepIndex: 5 },
  letschat: { stepName: "research_calendar", stepIndex: 6 },
  meeting: { stepName: "research_meeting", stepIndex: 7 },
  looking: { stepName: "research_looking", stepIndex: 8 },
  results: { stepName: "research_results", stepIndex: 9 },
  suggestions: { stepName: "research_suggestions", stepIndex: 10 },
  // Post-terminal loading state (personality rewrite finishing before chat). We
  // don't emit for it — the flow's completion is recorded on `suggestions` — but
  // it's a `ResearchStep`, so the exhaustive record needs an entry.
  finishing: { stepName: "research_finishing", stepIndex: 11 },
  // Established-assistant guard — an off-ramp branch after the form, not a
  // sequential stage, so it takes the next free index rather than renumbering
  // the funnel. Outcome: "completed" = kept the assistant (left for chat),
  // "skipped" = declined the off-ramp and redid onboarding anyway.
  existing: { stepName: "research_existing_assistant", stepIndex: 12 },
} as const satisfies Record<ResearchStep, OnboardingFunnelStepDescriptor>;

export type ResearchOnboardingFunnelStep =
  (typeof RESEARCH_ONBOARDING_FUNNEL_STEPS)[keyof typeof RESEARCH_ONBOARDING_FUNNEL_STEPS];

/**
 * Query param the app reads to attribute a deep-link landing to an onboarding
 * source, and the value the Day-2 check-in calendar event's CTA carries.
 *
 * The marketing-site UTM capture only runs on the marketing sites (platform
 * repo) and never sees `/assistant/*` app routes, so `utm_*` params on a link
 * that lands in the app do nothing. Instead the calendar CTA carries this
 * app-owned param, which the conversation route reads on landing and reports as
 * the funnel step below — same telemetry path as every other event here, so it
 * lands in BigQuery with no backend change. Kept in sync with the href built in
 * `assistant/src/onboarding/checkin-event.ts`.
 */
export const ONBOARDING_ATTRIBUTION_PARAM = "vref";
export const RESEARCH_CHECKIN_CALENDAR_ATTRIBUTION = "research_checkin";

/**
 * The check-in calendar-event click. Part of the research-onboarding funnel (it
 * rides RESEARCH_ONBOARDING_FUNNEL_VERSION), but fired a day later when the user
 * clicks the booked event's CTA rather than from an in-flow screen — so it isn't
 * a `ResearchStep` and lives outside RESEARCH_ONBOARDING_FUNNEL_STEPS, which is
 * keyed to the in-flow steps. Indexed after the last in-flow step.
 */
export const RESEARCH_ONBOARDING_CHECKIN_STEP = {
  stepName: "research_checkin_open",
  stepIndex: 11,
} as const satisfies OnboardingFunnelStepDescriptor;

/**
 * How the user left a step: `completed` (clicked the primary Continue/action) vs
 * `skipped` (clicked Skip). Lets analytics tell a deliberate completion apart
 * from a skip on steps that offer both. The pre-chat funnel omits this (it never
 * distinguished the two), so it ingests as null there.
 */
export type OnboardingFunnelStepOutcome = "completed" | "skipped";

export interface OnboardingFunnelStepCompletedOptions {
  userId?: string | null;
  variant?: OnboardingFunnelVariant;
  /** Funnel this step belongs to; defaults to the pre-chat funnel version. */
  funnelVersion?: string;
  /** Completed vs skipped; omitted when the funnel doesn't distinguish. */
  outcome?: OnboardingFunnelStepOutcome;
}

export interface OnboardingFunnelEvent {
  type: "onboarding";
  daemon_event_id: string;
  recorded_at: number;
  screen: string;
  session_id: string;
  step_name: string;
  step_index: number;
  completed_at: string;
  user_id: string | null;
  funnel_version: string;
  ab_variant: OnboardingFunnelVariant;
  /** Completed vs skipped; absent when the funnel doesn't distinguish. */
  outcome?: OnboardingFunnelStepOutcome;
}

export function getOnboardingFunnelSessionId(): string {
  if (typeof window === "undefined") return crypto.randomUUID();
  let existing = "";
  try {
    existing = sessionStorage.getItem(SESSION_STORAGE_KEY) ?? "";
  } catch {
    existing = "";
  }
  if (existing) return existing;
  const next = crypto.randomUUID();
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, next);
  } catch {
    // Storage may be unavailable; the current event still carries a valid id.
  }
  return next;
}

function isOnboardingFunnelVariant(
  value: string | null,
): value is OnboardingFunnelVariant {
  return (
    value === ONBOARDING_FUNNEL_VARIANTS.control ||
    value === ONBOARDING_FUNNEL_VARIANTS.paredDown
  );
}

export function readOnboardingFunnelVariant(): OnboardingFunnelVariant | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = sessionStorage.getItem(VARIANT_STORAGE_KEY);
    return isOnboardingFunnelVariant(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function resolveOnboardingFunnelVariant(
  preferred: OnboardingFunnelVariant,
): OnboardingFunnelVariant {
  const existing = readOnboardingFunnelVariant();
  if (existing) return existing;
  if (typeof window === "undefined") return preferred;
  try {
    sessionStorage.setItem(VARIANT_STORAGE_KEY, preferred);
  } catch {
    // Storage may be unavailable; the current event still carries the variant.
  }
  return preferred;
}

export function buildOnboardingFunnelEvent(
  screen: OnboardingFunnelStepDescriptor,
  options: OnboardingFunnelStepCompletedOptions = {},
): OnboardingFunnelEvent {
  const now = Date.now();
  const variant =
    options.variant ??
    readOnboardingFunnelVariant() ??
    ONBOARDING_FUNNEL_VARIANTS.control;
  return {
    type: "onboarding",
    daemon_event_id: crypto.randomUUID(),
    recorded_at: now,
    screen: screen.stepName,
    session_id: getOnboardingFunnelSessionId(),
    step_name: screen.stepName,
    step_index: screen.stepIndex,
    completed_at: new Date(now).toISOString(),
    user_id: options.userId ?? null,
    funnel_version: options.funnelVersion ?? ONBOARDING_FUNNEL_VERSION,
    ab_variant: variant,
    // Omitted (→ stripped before send) unless the caller distinguishes the two.
    outcome: options.outcome,
  };
}

export function emitOnboardingFunnelStepCompleted(
  screen: OnboardingFunnelStepDescriptor,
  options: OnboardingFunnelStepCompletedOptions = {},
): void {
  if (typeof window === "undefined") return;
  if (!readShareAnalytics()) return;

  postTelemetryEvents([buildOnboardingFunnelEvent(screen, options)]);
}

/**
 * Emit a research-onboarding step as completed. Fired whenever the user leaves a
 * step — whether by continuing or skipping — mirroring the pre-chat funnel, which
 * emits the same step-completed event on both its Continue and Skip handlers.
 *
 * The research flow has no A/B arm, so events are stamped with the `control`
 * variant (passed explicitly so this never reads the pre-chat funnel's stored
 * variant) and the research funnel version.
 *
 * `outcome` records whether the step was completed (Continue) or skipped;
 * defaults to `completed` for the Continue-only steps.
 */
export function emitResearchOnboardingStepCompleted(
  step: ResearchOnboardingFunnelStep,
  options: {
    userId?: string | null;
    outcome?: OnboardingFunnelStepOutcome;
  } = {},
): void {
  emitOnboardingFunnelStepCompleted(step, {
    userId: options.userId,
    variant: ONBOARDING_FUNNEL_VARIANTS.control,
    funnelVersion: RESEARCH_ONBOARDING_FUNNEL_VERSION,
    outcome: options.outcome ?? "completed",
  });
}

/**
 * Emit the research-onboarding check-in calendar-event click. Reached when the
 * user clicks the CTA in the Day-2 check-in calendar event a day after finishing
 * onboarding, so it's stamped with the research funnel version and `control`
 * variant exactly like the in-flow steps — just sourced from the deep-link's
 * attribution param instead of an on-screen Continue/Skip.
 */
export function emitResearchOnboardingCheckinCalendarOpened(
  options: { userId?: string | null } = {},
): void {
  emitOnboardingFunnelStepCompleted(RESEARCH_ONBOARDING_CHECKIN_STEP, {
    userId: options.userId,
    variant: ONBOARDING_FUNNEL_VARIANTS.control,
    funnelVersion: RESEARCH_ONBOARDING_FUNNEL_VERSION,
    outcome: "completed",
  });
}

export function __resetOnboardingFunnelEventsForTests(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    sessionStorage.removeItem(VARIANT_STORAGE_KEY);
  } catch {
    // ignore
  }
}
