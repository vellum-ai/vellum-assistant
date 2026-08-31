/**
 * Telemetry for the app-download nudges, riding the existing onboarding funnel
 * pipeline: same event shape, ingest path, and analytics-consent gating as
 * `tips-telemetry.ts`. The backend stores `step_name`/`funnel_version` as open
 * strings, so these need no backend change and land in `onboarding_raw`.
 *
 * `screen` carries both dimensions as `<surface>:<target>` (`banner:ios`,
 * `settings:android`), so one query can split click-through by where the nudge
 * rendered and which app it promoted without a second field. There is no A/B
 * arm here, so `ab_variant` stays `control`.
 */

import { emitOnboardingFunnelStepCompleted } from "@/domains/onboarding/funnel-events";
import { readAnalyticsConsent } from "@/lib/telemetry/consent";

export const NATIVE_APP_NUDGE_FUNNEL_VERSION = "native_app_nudge_v1_2026_08";

/** Where the nudge rendered. */
export type NudgeSurface = "banner" | "settings";

/** Which app the nudge promoted. `NudgeTarget` plus the macOS desktop app. */
export type NudgeTelemetryTarget = "ios" | "android" | "generic" | "macos";

export type NudgeTelemetryAction = "impression" | "click" | "dismiss";

const ACTION_STEP_INDICES: Record<NudgeTelemetryAction, number> = {
  impression: 0,
  click: 1,
  dismiss: 2,
};

export function emitNativeAppNudgeEvent(
  action: NudgeTelemetryAction,
  surface: NudgeSurface,
  target: NudgeTelemetryTarget,
): void {
  emitOnboardingFunnelStepCompleted(
    { stepName: action, stepIndex: ACTION_STEP_INDICES[action] },
    {
      funnelVersion: NATIVE_APP_NUDGE_FUNNEL_VERSION,
      screen: `${surface}:${target}`,
    },
  );
}

const IMPRESSIONS_SEEN_KEY = "nativeAppNudge.impressionsSeen";

function readImpressionsSeen(): string[] {
  try {
    const raw = sessionStorage.getItem(IMPRESSIONS_SEEN_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v) => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Emit an impression at most once per browser session per nudge.
 *
 * Session scope, not component scope: the funnel's `session_id` lives in
 * sessionStorage, so a ref on the calling component would reset on every
 * remount (leaving chat for Settings and coming back) and bill a second
 * impression inside one session, inflating the denominator the click-through
 * rate divides by.
 *
 * When storage is unavailable the read yields `[]` and the write is dropped,
 * so the nudge degrades to emitting per mount rather than going silent.
 * Telemetry is best-effort and a missing impression is worse than a repeat.
 *
 * Consent is checked HERE as well as inside the emitter, because the marker
 * must not be spent on an event the gate goes on to drop: someone who opts in
 * mid-session would come back to a banner already marked seen and report a
 * click with no impression behind it.
 */
export function emitNativeAppNudgeImpressionOnce(
  surface: NudgeSurface,
  target: NudgeTelemetryTarget,
): void {
  if (!readAnalyticsConsent()) {
    return;
  }
  const key = `${surface}:${target}`;
  const seen = readImpressionsSeen();
  if (seen.includes(key)) {
    return;
  }
  try {
    sessionStorage.setItem(
      IMPRESSIONS_SEEN_KEY,
      JSON.stringify([...seen, key]),
    );
  } catch {
    // Storage disabled; emit anyway rather than lose the impression.
  }
  emitNativeAppNudgeEvent("impression", surface, target);
}
