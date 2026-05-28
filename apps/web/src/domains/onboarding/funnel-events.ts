import { readShareAnalytics } from "@/domains/onboarding/prefs";
import { getClientId } from "@/lib/telemetry/client-identity";

export const ONBOARDING_FUNNEL_VERSION = "onboarding_v3_2026_05";
const SESSION_STORAGE_KEY = "onboarding.funnelSessionId";

export const ONBOARDING_FUNNEL_STEPS = {
  privacyTos: { stepName: "privacy_tos", stepIndex: 0 },
  nameVibe: { stepName: "name_vibe", stepIndex: 1 },
  gmailConnect: { stepName: "gmail_connect", stepIndex: 2 },
} as const;

export type OnboardingFunnelStep =
  (typeof ONBOARDING_FUNNEL_STEPS)[keyof typeof ONBOARDING_FUNNEL_STEPS];

export type OnboardingFunnelStepName = OnboardingFunnelStep["stepName"];

export interface OnboardingFunnelStepCompletedOptions {
  userId?: string | null;
}

export interface OnboardingFunnelEvent {
  type: "onboarding";
  daemon_event_id: string;
  recorded_at: number;
  screen: OnboardingFunnelStepName;
  session_id: string;
  step_name: OnboardingFunnelStepName;
  step_index: number;
  completed_at: string;
  user_id: string | null;
  funnel_version: string;
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

export function buildOnboardingFunnelEvent(
  screen: OnboardingFunnelStep,
  options: OnboardingFunnelStepCompletedOptions = {},
): OnboardingFunnelEvent {
  const now = Date.now();
  return {
    type: "onboarding",
    daemon_event_id: `web-onboarding-${crypto.randomUUID()}`,
    recorded_at: now,
    screen: screen.stepName,
    session_id: getOnboardingFunnelSessionId(),
    step_name: screen.stepName,
    step_index: screen.stepIndex,
    completed_at: new Date(now).toISOString(),
    user_id: options.userId ?? null,
    funnel_version: ONBOARDING_FUNNEL_VERSION,
  };
}

export function emitOnboardingFunnelStepCompleted(
  screen: OnboardingFunnelStep,
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

export function __resetOnboardingFunnelEventsForTests(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}
