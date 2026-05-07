/**
 * Inference profile session reaper.
 *
 * Periodically scans the `conversations` table for rows whose
 * session-backed inference profile has expired (`inference_profile_expires_at`
 * is in the past) and clears them.  For each cleared session a
 * `conversation_inference_profile_updated` event is published so connected
 * clients receive an immediate update without polling.
 *
 * The reaper runs every 30 seconds and is started alongside the other
 * background sweeps in `http-server.ts`.
 */

import { clearExpiredInferenceProfiles } from "../../memory/conversation-crud.js";
import { getLogger } from "../../util/logger.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";

const log = getLogger("inference-profile-session-reaper");

/** Interval at which the reaper runs (30 seconds). */
const REAPER_INTERVAL_MS = 30_000;

/** Timer handle for the reaper so it can be stopped in tests and shutdown. */
let reaperTimer: ReturnType<typeof setInterval> | null = null;

/** Guard against overlapping reaper runs. */
let reaperInProgress = false;

/**
 * Tick the inference profile session reaper once.
 *
 * Clears all conversations whose session-backed inference profile has expired
 * and emits a `conversation_inference_profile_updated` event for each one.
 * Exported for direct use in tests.
 */
export function tickInferenceProfileReaper(): void {
  const now = Date.now();
  const cleared = clearExpiredInferenceProfiles(now);
  for (const { conversationId } of cleared) {
    assistantEventHub
      .publish(
        buildAssistantEvent(
          {
            type: "conversation_inference_profile_updated",
            conversationId,
            profile: null,
            sessionId: null,
            expiresAt: null,
          },
          conversationId,
        ),
      )
      .catch((err) => {
        log.warn(
          { err, conversationId },
          "Failed to publish inference profile expiry event",
        );
      });
  }
  if (cleared.length > 0) {
    log.info(
      { count: cleared.length },
      "Inference profile session reaper: cleared expired sessions",
    );
  }
}

/**
 * Start the periodic inference profile session reaper. Idempotent — calling
 * it multiple times reuses the same timer.
 */
export function startInferenceProfileSessionReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    if (reaperInProgress) return;
    reaperInProgress = true;
    try {
      tickInferenceProfileReaper();
    } catch (err) {
      log.error({ err }, "Inference profile session reaper failed");
    } finally {
      reaperInProgress = false;
    }
  }, REAPER_INTERVAL_MS);
}

/**
 * Stop the periodic inference profile session reaper. Used in tests and
 * shutdown.
 */
export function stopInferenceProfileSessionReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
  reaperInProgress = false;
}
