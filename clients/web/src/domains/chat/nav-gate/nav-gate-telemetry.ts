/**
 * Telemetry for the sidenav-gating experiment.
 *
 * Events ride the same `/v1/telemetry/ingest/` substrate and field shape as
 * the onboarding funnels (open-string `step_name`/`funnel_version`, so no
 * backend change), under their own funnel version. `ab_variant` carries the
 * experiment arm — `session_end_without_message` emits for BOTH arms (it's
 * the counter-metric: if gating converts wanderers into bounces, the welcome
 * message is the real problem, not the chrome).
 *
 * Event vocabulary (from the experiment design, required day one):
 *   - `click_on_disabled_item` — screen = item id, step_index = attempt.
 *     The richest output: which chrome items are the strongest distraction
 *     magnets, and how much demand each gate suppresses.
 *   - `quiet_unlock` — third click on one item; how often the gate is wrong.
 *   - `session_end_without_message` — pagehide with zero sent messages.
 */

import { readAnalyticsConsent } from "@/lib/telemetry/consent";
import { postTelemetryEvents } from "@/lib/telemetry/ingest";
import { useAuthStore } from "@/stores/auth-store";
import type {
  NavGateArm,
  NavGateItemId,
} from "@/domains/chat/nav-gate/nav-gate-store";

export const NAV_GATE_FUNNEL_VERSION = "sidenav_gating_v1_2026_07";

const SESSION_ID_KEY = "vellum:nav-gate:sessionId";

/** Step indexes are stable per event name; attempt rides `step_index` only
 *  for clicks, where it IS the interesting dimension. */
const EVENT_BASE_INDEX = {
  click_on_disabled_item: 0,
  quiet_unlock: 10,
  session_end_without_message: 20,
} as const;

type NavGateEventName = keyof typeof EVENT_BASE_INDEX;

function sessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_ID_KEY);
    if (existing) {
      return existing;
    }
    const next = crypto.randomUUID();
    sessionStorage.setItem(SESSION_ID_KEY, next);
    return next;
  } catch {
    return crypto.randomUUID();
  }
}

function emit(
  name: NavGateEventName,
  arm: NavGateArm,
  options: { screen?: string; stepIndex?: number } = {},
): void {
  if (typeof window === "undefined") {
    return;
  }
  // Only the experiment cohort emits; `none` is everyone else on the default
  // flag value.
  if (arm === "none") {
    return;
  }
  if (!readAnalyticsConsent()) {
    return;
  }
  const now = Date.now();
  postTelemetryEvents([
    {
      type: "onboarding",
      daemon_event_id: crypto.randomUUID(),
      recorded_at: now,
      screen: options.screen ?? name,
      session_id: sessionId(),
      step_name: name,
      step_index: options.stepIndex ?? EVENT_BASE_INDEX[name],
      completed_at: new Date(now).toISOString(),
      user_id: useAuthStore.getState().user?.id ?? null,
      funnel_version: NAV_GATE_FUNNEL_VERSION,
      ab_variant: arm,
    },
  ]);
}

export function emitDisabledItemClick(
  arm: NavGateArm,
  item: NavGateItemId,
  attempt: number,
): void {
  emit("click_on_disabled_item", arm, { screen: item, stepIndex: attempt });
}

export function emitQuietUnlock(arm: NavGateArm, item: NavGateItemId): void {
  emit("quiet_unlock", arm, { screen: item });
}

export function emitSessionEndWithoutMessage(arm: NavGateArm): void {
  emit("session_end_without_message", arm);
}
