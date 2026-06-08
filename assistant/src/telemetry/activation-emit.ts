/**
 * Mechanism-agnostic activation emit handler.
 *
 * This is the seam that model-facing callers (e.g. the activation tool) use to
 * emit an activation-funnel milestone. It validates the step name and otherwise
 * records the event best-effort — it never throws, so the model can never crash
 * a turn through this path.
 */

import { isActivationSession } from "../memory/activation-session-store.js";
import { recordActivationEvent } from "../memory/onboarding-events-store.js";
import { getLogger } from "../util/logger.js";
import { isActivationStepName } from "./activation-funnel.js";

const log = getLogger("activation-emit");

/**
 * Emit an activation-funnel milestone for a conversation.
 *
 * Returns `{ ok: true }` on success (including the success-noop case where
 * usage-data collection is disabled). Returns `{ ok: false, reason }` for an
 * unknown step (`"unknown_step"`), a conversation that was never marked as an
 * activation rail session (`"not_activation_session"`), or a failed record
 * (`"record_failed"`). Never throws.
 */
export function emitActivationMoment(input: {
  stepName: string;
  conversationId: string;
  userId?: string | null;
}): { ok: boolean; reason?: string } {
  if (!isActivationStepName(input.stepName)) {
    return { ok: false, reason: "unknown_step" };
  }
  // Only emit for conversations actually running the activation rail. The rail
  // marker (activation_sessions) is set in system-prompt.ts only when the
  // activation-rail bootstrap is active, so gating here prevents a stray tool
  // call in a normal chat from polluting the activation funnel with a
  // spurious conversion.
  if (!isActivationSession(input.conversationId)) {
    return { ok: false, reason: "not_activation_session" };
  }

  try {
    // A null return (collectUsageData disabled) is a success-noop.
    recordActivationEvent({
      stepName: input.stepName,
      sessionId: input.conversationId,
      userId: input.userId,
    });
    return { ok: true };
  } catch (err) {
    log.warn({ err, stepName: input.stepName }, "recordActivationEvent failed");
    return { ok: false, reason: "record_failed" };
  }
}
