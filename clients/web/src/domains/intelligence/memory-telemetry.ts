import { getDeviceBool } from "@/utils/device-settings";
import { postTelemetryEvents } from "@/lib/telemetry/ingest";

/**
 * Memory-tab usage telemetry.
 *
 * Reports through the shared `postTelemetryEvents` transport as a
 * `type: "onboarding"` event with a distinct `funnel_version`
 * (`memory_tab_v1`). `screen` / `step_name` / `funnel_version` are open strings
 * server-side, so these values ride the existing ingest wire shape.
 *
 * Consent is read from the shared `device:share_analytics` bool
 * (`getDeviceBool("shareAnalytics", ...)`) rather than the onboarding domain's
 * `readShareAnalytics()` — the intelligence domain can't import from onboarding
 * (`local/no-cross-domain-imports`), and the device bool is the same persistent
 * opt-out signal that reader gates on (and that `/settings/privacy` and the
 * Sentry consent gate read directly).
 */

export const MEMORY_FUNNEL_VERSION = "memory_tab_v1";

/** Which Memory-tab interaction is being reported. */
export type MemoryStep = "opened" | "search" | "node_opened" | "chat_from_node";

/**
 * Per-page-load session id, generated once when this module first loads. Ties
 * every Memory-tab event from a single load together, mirroring the onboarding
 * funnel's `session_id`.
 */
const SESSION_ID = crypto.randomUUID();

interface MemoryEvent {
  type: "onboarding";
  daemon_event_id: string;
  recorded_at: number;
  screen: string;
  session_id: string;
  step_name: string;
  funnel_version: string;
  user_id?: string;
}

export function emitMemoryEvent(
  step: MemoryStep,
  options: { userId?: string } = {},
): void {
  if (typeof window === "undefined") {
    return;
  }
  // Analytics is opt-out; an absent preference authorizes uploads.
  if (!getDeviceBool("shareAnalytics", true)) {
    return;
  }

  const event: MemoryEvent = {
    type: "onboarding",
    daemon_event_id: crypto.randomUUID(),
    recorded_at: Date.now(),
    screen: "memory",
    session_id: SESSION_ID,
    step_name: step,
    funnel_version: MEMORY_FUNNEL_VERSION,
    // Omitted (→ stripped before send) when the caller has no user id.
    user_id: options.userId,
  };

  postTelemetryEvents([event]);
}
