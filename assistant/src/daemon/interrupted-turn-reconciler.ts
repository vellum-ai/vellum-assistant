/**
 * Startup reconciliation for conversations left mid-turn by the previous
 * process. Their `processing_started_at` is still set even though the
 * in-memory agent loop that owned the turn died with that process, so the
 * flag is stale: clients would render the conversation as busy forever and
 * background jobs (e.g. memory retrospectives) would skip it.
 *
 * The reconciler always clears the stale flags. When
 * `conversations.resumeProcessingOnStartup` is enabled it additionally
 * selects conversations to resume through the conversation-wake machinery —
 * a normal background turn that shows the model an interruption notice and
 * lets it decide what still needs doing, rather than mechanically replaying
 * the dead turn (tool side effects are not idempotent, and the transcript
 * already contains whatever the interrupted turn persisted).
 */

import {
  clearStaleProcessingFlags,
  incrementProcessingResumeAttempts,
  listInterruptedConversations,
} from "../persistence/conversation-crud.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("interrupted-turns");

/**
 * Maximum consecutive auto-resume attempts per conversation. The persisted
 * counter survives `clearStaleProcessingFlags()` and resets only on a clean
 * turn end, so a resumed turn that keeps taking the process down is left
 * idle after this many boots instead of resume-looping forever.
 */
export const MAX_RESUME_ATTEMPTS = 2;

/**
 * Wake hint injected into the resumed turn. Deliberately instructs the model
 * to judge what remains unfinished instead of redoing the turn wholesale —
 * effects of already-executed tools are visible in the transcript and must
 * not be repeated.
 */
const INTERRUPTED_TURN_RESUME_HINT =
  "Your previous turn in this conversation was interrupted by an assistant " +
  "restart before it finished. Review the recent messages and complete " +
  "whatever was left unfinished. Do not repeat actions whose effects are " +
  "already visible in the conversation. If nothing actionable remains, send " +
  "a brief note acknowledging the reply was cut short so the conversation " +
  "isn't left hanging.";

export interface InterruptedTurnReconciliation {
  /** Rows whose stale processing flag was cleared. */
  cleared: number;
  /** Conversation ids selected for an auto-resume wake. */
  resume: string[];
  /** Conversation ids left idle because they hit {@link MAX_RESUME_ATTEMPTS}. */
  capped: string[];
}

/**
 * Clear every stale processing flag and, when `resumeEnabled` is set, pick
 * the conversations to resume. Each selected conversation's persisted
 * resume-attempt counter is bumped before its id is returned, so a resume
 * that dies mid-turn is charged even though the wake itself happens later.
 *
 * Pure DB work — safe to run during startup as soon as migrations settle.
 * The wakes themselves must wait for full startup (providers, CES) and run
 * via {@link resumeInterruptedConversations}.
 */
export function reconcileInterruptedConversations(
  resumeEnabled: boolean,
): InterruptedTurnReconciliation {
  const interrupted = resumeEnabled ? listInterruptedConversations() : [];
  const cleared = clearStaleProcessingFlags();
  if (!resumeEnabled) {
    return { cleared, resume: [], capped: [] };
  }
  const resume: string[] = [];
  const capped: string[] = [];
  for (const row of interrupted) {
    if (row.resumeAttempts >= MAX_RESUME_ATTEMPTS) {
      capped.push(row.id);
      continue;
    }
    incrementProcessingResumeAttempts(row.id);
    resume.push(row.id);
  }
  return { cleared, resume, capped };
}

/**
 * Resume interrupted conversations sequentially through the conversation
 * wake machinery. Sequential on purpose: a boot after a mid-turn crash can
 * carry several interrupted conversations, and running them one at a time
 * avoids a thundering herd of concurrent LLM turns right after startup.
 *
 * Each wake runs clientless (background policy: side-effecting tools are
 * denied at the default threshold instead of stalling on an absent client)
 * and without a trust elevation — the turn runs under the conversation's own
 * resting trust, so resuming an interrupted low-trust turn can never grant
 * it guardian-class capability. Failures are logged and skipped so one bad
 * conversation doesn't block the rest.
 *
 * `agent-wake` is imported lazily: this module is loaded during early daemon
 * startup, and the wake machinery statically pulls in the agent-loop stack,
 * which must not join the lifecycle import graph (daemon ↔ runtime cycles).
 */
export async function resumeInterruptedConversations(
  conversationIds: string[],
): Promise<void> {
  const { wakeAgentForOpportunity } = await import("../runtime/agent-wake.js");
  for (const conversationId of conversationIds) {
    try {
      const result = await wakeAgentForOpportunity({
        conversationId,
        hint: INTERRUPTED_TURN_RESUME_HINT,
        source: "interrupted-turn-resume",
        clientless: true,
        persistTriggerAsEvent: true,
      });
      log.info(
        {
          conversationId,
          invoked: result.invoked,
          producedToolCalls: result.producedToolCalls,
          reason: result.reason,
        },
        "Interrupted-turn resume wake finished",
      );
    } catch (err) {
      log.warn(
        { err, conversationId },
        "Interrupted-turn resume wake failed — continuing with remaining conversations",
      );
    }
  }
}
