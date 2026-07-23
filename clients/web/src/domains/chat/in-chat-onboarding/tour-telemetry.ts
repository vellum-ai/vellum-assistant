/**
 * Telemetry for the in-chat onboarding tour experiment. Rides the
 * onboarding funnel event shape and ingest path (`funnel-events.ts`) — the
 * backend stores `step_name`/`funnel_version` as open strings, so these
 * need no backend change — and stamps every event with the
 * `in-chat-onboarding-tour` arm as `ab_variant`, so BigQuery can compare
 * the 70% `tour` arm against `control`.
 *
 * Events:
 * - `tour_exposed`   — the post-onboarding hand-off, fired for BOTH arms;
 *                      the control cohort emits nothing else, and the
 *                      experiment needs its rows for comparison.
 * - `tour_started`   — the tour began; `screen` records the trigger
 *                      (`auto` = post-onboarding hand-off, `replay` = the
 *                      header button).
 * - `tour_skipped`   — Skip pressed; `screen` records which beat it was
 *                      pressed on (`beat_<index>_of_<count>`).
 * - `tour_completed` — the user walked every beat to the end.
 */

import { emitOnboardingFunnelStepCompleted } from "@/domains/onboarding/funnel-events";

import { readInChatTourVariant } from "./in-chat-tour-flag";

export const IN_CHAT_TOUR_FUNNEL_VERSION = "in_chat_tour_v1_2026_07";

export const IN_CHAT_TOUR_FUNNEL_STEPS = {
  exposed: { stepName: "tour_exposed", stepIndex: 0 },
  started: { stepName: "tour_started", stepIndex: 1 },
  completed: { stepName: "tour_completed", stepIndex: 2 },
  skipped: { stepName: "tour_skipped", stepIndex: 3 },
} as const;

/** How the tour began: the post-onboarding hand-off or the header button. */
export type InChatTourTrigger = "auto" | "replay";

/** The arm-exposure moment — emitted for every user (both arms) at the
 *  post-onboarding hand-off, stamped with their assigned arm. */
export function emitInChatTourExposed(): void {
  emitOnboardingFunnelStepCompleted(IN_CHAT_TOUR_FUNNEL_STEPS.exposed, {
    funnelVersion: IN_CHAT_TOUR_FUNNEL_VERSION,
    variant: readInChatTourVariant(),
    outcome: "completed",
  });
}

export function emitInChatTourStarted(trigger: InChatTourTrigger): void {
  emitOnboardingFunnelStepCompleted(IN_CHAT_TOUR_FUNNEL_STEPS.started, {
    funnelVersion: IN_CHAT_TOUR_FUNNEL_VERSION,
    variant: readInChatTourVariant(),
    screen: trigger,
    outcome: "completed",
  });
}

export function emitInChatTourSkipped(
  beatIndex: number,
  beatCount: number,
): void {
  emitOnboardingFunnelStepCompleted(IN_CHAT_TOUR_FUNNEL_STEPS.skipped, {
    funnelVersion: IN_CHAT_TOUR_FUNNEL_VERSION,
    variant: readInChatTourVariant(),
    screen: `beat_${beatIndex}_of_${beatCount}`,
    outcome: "skipped",
  });
}

export function emitInChatTourCompleted(): void {
  emitOnboardingFunnelStepCompleted(IN_CHAT_TOUR_FUNNEL_STEPS.completed, {
    funnelVersion: IN_CHAT_TOUR_FUNNEL_VERSION,
    variant: readInChatTourVariant(),
    outcome: "completed",
  });
}
