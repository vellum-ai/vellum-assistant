/**
 * Shared construction of the wake invocation a `mode: "wake"` schedule fires.
 *
 * The scheduler's due-tick and the manual "run now" route both resume the
 * schedule's target conversation, so they build the same invocation here rather
 * than each assembling their own.
 */

import { recoverRestingTrustContext } from "../daemon/conversation-resting-trust.js";
import type { WakeOptions } from "../runtime/agent-wake.js";
import { hasOwnerDeferProvenance } from "./defer-provenance.js";
import type { ScheduleJob } from "./schedule-store.js";

/** The schedule fields a wake firing reads. */
type WakeScheduleFields = Pick<
  ScheduleJob,
  "message" | "inferenceProfile" | "createdBy" | "createdFromConversationId"
>;

/**
 * Whether this row carries durable proof that its wake target and trigger text
 * were chosen by the assistant's owner.
 *
 * The due-tick has no caller: it cannot re-derive who selected the target, so
 * the row itself has to carry the answer, in fields no update path can rewrite.
 * Two independent ones must agree:
 *
 * - `createdBy` is {@link hasOwnerDeferProvenance}. Set only by `defer/create`,
 *   which is owner-gated, and absent from `updateSchedule`'s signature, so no
 *   route, tool, or CLI command can write it after creation.
 * - `createdFromConversationId` equals the wake target. Also write-once at
 *   creation, so retargeting `wakeConversationId` breaks the equality even if
 *   the update surface's own guard were bypassed or regressed.
 *
 * Rows written before this proof existed carry neither, so they fail closed.
 * That is deliberate and cannot be relaxed: while the update surface still
 * accepted `wakeConversationId`, an actor could have retargeted an existing
 * defer, and nothing distinguishes such a row from an untouched one. A legacy
 * defer keeps firing and keeps its place in the defer list; its woken turn
 * simply runs at the fail-closed `unknown` class, exactly as every wake did
 * before this proof was introduced. Re-creating the defer earns the elevation.
 */
function hasOwnerAuthoredWakeTarget(
  job: WakeScheduleFields,
  wakeConversationId: string,
): boolean {
  return (
    hasOwnerDeferProvenance(job.createdBy) &&
    job.createdFromConversationId === wakeConversationId
  );
}

/**
 * Build the {@link WakeOptions} for firing a wake schedule against
 * `wakeConversationId`.
 *
 * A wake schedule carries no actor of its own: it is a deferral set on a
 * conversation that already exists, and nobody is on the other end when it
 * fires. So the woken turn runs under the target conversation's own resting
 * trust ({@link recoverRestingTrustContext}), never more. For the guardian's
 * own local conversation that is guardian, which is what lets the resumed turn
 * keep using the sensitive tools it was using before it deferred.
 *
 * Elevation needs BOTH halves, and grants the lesser of them:
 *
 * - **The row must prove an owner chose its target and text**
 *   ({@link hasOwnerAuthoredWakeTarget}). Naming a privileged conversation is
 *   therefore not itself the grant.
 * - **The target must be guardian-owned** ({@link recoverRestingTrustContext}).
 *   Trust comes from the conversation the wake lands in, so a wake can never
 *   rise above its target: a remote-channel conversation recovers nothing and
 *   its turn resolves the fail-closed `unknown` class.
 *
 * Callers are separately responsible for authorizing the firing itself. The
 * scheduler's due-tick has no caller to authorize; `schedules/:id/run` refuses
 * a non-owner before reaching this function.
 */
export function buildWakeScheduleOptions(
  job: WakeScheduleFields,
  wakeConversationId: string,
): WakeOptions {
  const trustContext = hasOwnerAuthoredWakeTarget(job, wakeConversationId)
    ? recoverRestingTrustContext(wakeConversationId)
    : null;
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
