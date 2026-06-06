/**
 * Mechanism-agnostic activation emit handler.
 *
 * This is the seam that model-facing callers (e.g. the activation tool) use to
 * emit an activation-funnel milestone. It validates the step name, rejects the
 * daemon-owned `activation_msg_5_sent` step (emitted only by the turn hook),
 * and otherwise records the event best-effort — it never throws, so the model
 * can never crash a turn through this path.
 */

import { recordActivationEvent } from "../memory/onboarding-events-store.js";
import { getLogger } from "../util/logger.js";
import { ACTIVATION_STEPS, isActivationStepName } from "./activation-funnel.js";

const log = getLogger("activation-emit");

/**
 * Emit an activation-funnel milestone for a conversation.
 *
 * Returns `{ ok: true }` on success (including the success-noop case where
 * usage-data collection is disabled). Returns `{ ok: false, reason }` for an
 * unknown step (`"unknown_step"`), the daemon-owned msg_5 step
 * (`"daemon_owned"`), or a failed record (`"record_failed"`). Never throws.
 */
export function emitActivationMoment(input: {
  stepName: string;
  conversationId: string;
  userId?: string | null;
}): { ok: boolean; reason?: string } {
  if (!isActivationStepName(input.stepName)) {
    return { ok: false, reason: "unknown_step" };
  }
  // msg_5 is emitted only by the daemon turn hook, never via this handler.
  if (input.stepName === ACTIVATION_STEPS.msg5Sent.stepName) {
    return { ok: false, reason: "daemon_owned" };
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
