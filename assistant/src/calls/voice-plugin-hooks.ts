/** Plugin-agnostic lifecycle signals emitted by live-voice orchestration. */

import type { VoiceFrontDoorOutcome } from "../hooks/types.js";
import { HOOKS } from "../plugin-api/constants.js";
import { runHook } from "../plugins/pipeline.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("voice-plugin-hooks");

/**
 * Notify plugins that a front-door leg has reached its terminal outcome.
 * Hook work is detached because cleanup must not extend voice response time.
 */
export function notifyVoiceFrontDoorSettled(
  conversationId: string,
  outcome: VoiceFrontDoorOutcome,
): void {
  void runHook(HOOKS.VOICE_FRONT_DOOR_SETTLED, {
    conversationId,
    outcome,
  }).catch((err) => {
    log.warn(
      { err, conversationId, outcome },
      "Voice front-door settlement hook failed",
    );
  });
}
