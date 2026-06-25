import { readShareAnalytics } from "@/domains/onboarding/prefs";
import { getClientId } from "@/lib/telemetry/client-identity";
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
export const RESEARCH_ONBOARDING_FUNNEL_VERSION = "research_onboarding_v1_2026_06";

export const RESEARCH_ONBOARDING_FUNNEL_STEPS = {
  form: { stepName: "research_form", stepIndex: 0 },
  face: { stepName: "research_face", stepIndex: 1 },
  intro: { stepName: "research_intro", stepIndex: 2 },
  different: { stepName: "research_pitch", stepIndex: 3 },
  integration: { stepName: "research_integration", stepIndex: 4 },
  letschat: { stepName: "research_calendar", stepIndex: 5 },
  meeting: { stepName: "research_meeting", stepIndex: 6 },
  looking: { stepName: "research_looking", stepIndex: 7 },
  results: { stepName: "research_results", stepIndex: 8 },
  suggestions: { stepName: "research_suggestions", stepIndex: 9 },
} as const satisfies Record<ResearchStep, OnboardingFunnelStepDescriptor>;

export type ResearchOnboardingFunnelStep =
  (typeof RESEARCH_ONBOARDING_FUNNEL_STEPS)[keyof typeof RESEARCH_ONBOARDING_FUNNEL_STEPS];

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

function stripUndefined(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
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

  const event = stripUndefined(buildOnboardingFunnelEvent(screen, options));

  const payload = JSON.stringify({
    device_id: getClientId(),
    assistant_version: import.meta.env.VITE_APP_VERSION ?? "web-dev",
    events: [event],
  });

  void fetch("/v1/telemetry/ingest/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
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
  options: { userId?: string | null; outcome?: OnboardingFunnelStepOutcome } = {},
): void {
  emitOnboardingFunnelStepCompleted(step, {
    userId: options.userId,
    variant: ONBOARDING_FUNNEL_VARIANTS.control,
    funnelVersion: RESEARCH_ONBOARDING_FUNNEL_VERSION,
    outcome: options.outcome ?? "completed",
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
