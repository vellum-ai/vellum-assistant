/**
 * Telemetry for proactive tips, riding the existing onboarding funnel
 * pipeline: same event shape, ingest path, and analytics-consent gating
 * (`readShareAnalytics()` inside the base emitter). Each event lands with
 * `funnel_version: "proactive-tips-v1"`, `screen` = tip id, and
 * `step_name` = the action taken.
 */

import {
  emitOnboardingFunnelStepCompleted,
  type OnboardingFunnelVariant,
} from "@/domains/onboarding/funnel-events";

export const TIPS_FUNNEL_VERSION = "proactive-tips-v1";

export type TipTelemetryAction =
  | "impression"
  | "dismiss"
  | "learn_more"
  | "dont_show_again";

const ACTION_STEP_INDICES: Record<TipTelemetryAction, number> = {
  impression: 0,
  learn_more: 1,
  dismiss: 2,
  dont_show_again: 3,
};

export function emitTipEvent(
  tipId: string,
  action: TipTelemetryAction,
  variant: string,
): void {
  emitOnboardingFunnelStepCompleted(
    { stepName: action, stepIndex: ACTION_STEP_INDICES[action] },
    {
      funnelVersion: TIPS_FUNNEL_VERSION,
      screen: tipId,
      // The ingest stores ab_variant as an open string; the union type on the
      // base emitter documents the pre-chat A/B arms.
      variant: variant as OnboardingFunnelVariant,
    },
  );
}
