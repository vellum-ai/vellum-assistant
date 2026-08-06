import { readAnalyticsConsent } from "@/lib/telemetry/consent";
import { postTelemetryEvents } from "@/lib/telemetry/ingest";

/**
 * Memory-tab usage telemetry.
 *
 * Reports through the shared `postTelemetryEvents` transport as a
 * `type: "onboarding"` event with a distinct `funnel_version`
 * (`memory_tab_v1`). `screen` / `step_name` / `funnel_version` are open strings
 * server-side, so these values ride the existing ingest wire shape.
 *
 * Consent is read through the shared `readAnalyticsConsent()` — the exact same
 * decision the onboarding funnel gates on (the AND of the in-memory
 * `shareAnalytics` store flag and the persisted `device:share_analytics` bool).
 * Routing through the `lib/telemetry/` helper keeps the intelligence domain
 * from importing onboarding directly (`local/no-cross-domain-imports`) while
 * guaranteeing a failed opt-out write can't leave Memory telemetry uploading
 * after onboarding telemetry has stopped.
 */

const MEMORY_FUNNEL_VERSION = "memory_tab_v1";

/** Which Memory-tab interaction is being reported. */
type MemoryStep =
  | "opened"
  | "search"
  | "node_opened"
  | "chat_from_node"
  /** The unavailable-graph surface's CTA to migrate this assistant to memory
   * v3 — the conversion signal for the tab's one dead-end state. */
  | "upgrade_v3_clicked"
  /** Its sibling on a memory-off assistant: hand the `memory.enabled` flip to
   * the assistant, for users who can't reach the Developer page's toggle. */
  | "enable_memory_clicked";

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
}

export function emitMemoryEvent(step: MemoryStep): void {
  if (typeof window === "undefined") {
    return;
  }
  if (!readAnalyticsConsent()) {
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
  };

  postTelemetryEvents([event]);
}
