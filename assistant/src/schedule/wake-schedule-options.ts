/**
 * Shared construction of the wake invocation a `mode: "wake"` schedule fires.
 *
 * The scheduler's due-tick and the manual "run now" route both resume the
 * schedule's target conversation, so they build the same invocation here rather
 * than each assembling their own.
 */

import { recoverRestingTrustContext } from "../daemon/conversation-resting-trust.js";
import type { WakeOptions } from "../runtime/agent-wake.js";
import type { ScheduleJob } from "./schedule-store.js";

/** The schedule fields a wake firing reads. */
type WakeScheduleFields = Pick<ScheduleJob, "message" | "inferenceProfile">;

/**
 * Build the {@link WakeOptions} for firing a wake schedule against
 * `wakeConversationId`.
 *
 * A wake schedule carries no actor: it is a deferral the assistant set on a
 * conversation that already exists, and nobody is on the other end when it
 * fires. So the woken turn runs under the target conversation's own resting
 * trust ({@link recoverRestingTrustContext}), never more. For the guardian's
 * own local conversation that is guardian, which is what lets the resumed turn
 * keep using the sensitive tools it was using before it deferred. For a
 * conversation whose origin is a remote channel there is no resting trust to
 * recover, so `trustContext` is omitted and the turn resolves the fail-closed
 * `unknown` class, denying sensitive tools exactly as it does today.
 *
 * Trust is derived from the target conversation rather than from whoever
 * triggered the firing, so a manual "run now" cannot lift a wake above the
 * conversation it lands in.
 */
export function buildWakeScheduleOptions(
  job: WakeScheduleFields,
  wakeConversationId: string,
): WakeOptions {
  const trustContext = recoverRestingTrustContext(wakeConversationId);
  return {
    conversationId: wakeConversationId,
    hint: job.message,
    source: "defer",
    persistTriggerAsEvent: true,
    ...(trustContext ? { trustContext } : {}),
    ...(job.inferenceProfile
      ? { forceOverrideProfile: job.inferenceProfile }
      : {}),
  };
}
