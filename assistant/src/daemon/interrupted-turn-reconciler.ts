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
 *
 * Each resume runs under the conversation's reconstructed resting trust (see
 * {@link recoverRestingTrustContext}); conversations whose trust can't be
 * rebuilt from persisted state are cleared but left un-resumed.
 */

import {
  clearStaleProcessingFlags,
  getConversationOriginChannel,
  incrementProcessingResumeAttempts,
  listInterruptedConversations,
} from "../persistence/conversation-crud.js";
import { getLogger } from "../util/logger.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "./trust-context.js";
import type { TrustContext } from "./trust-context-types.js";

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

/**
 * A conversation selected for an auto-resume wake, paired with the resting
 * trust context the woken turn must run under.
 */
export interface InterruptedResumeTarget {
  conversationId: string;
  trustContext: TrustContext;
}

export interface InterruptedTurnReconciliation {
  /** Rows whose stale processing flag was cleared. */
  cleared: number;
  /** Conversations selected for an auto-resume wake, with their resting trust. */
  resume: InterruptedResumeTarget[];
  /** Conversation ids left idle because they hit {@link MAX_RESUME_ATTEMPTS}. */
  capped: string[];
  /**
   * Conversation ids left un-resumed because their resting trust could not be
   * reconstructed from persisted state (a remote-channel turn whose per-actor
   * gateway verdict is not stored). Their stale flag is still cleared.
   */
  trustUnrecoverable: string[];
}

/**
 * Rebuild the trust context an interrupted conversation must resume under, or
 * `null` when it can't be recovered.
 *
 * Only the guardian's own local conversations are recoverable at rest: a
 * remote-channel turn's trust class is stamped per inbound message from the
 * gateway verdict and never persisted, so it cannot be reconstructed here.
 * Local conversations — `originChannel` unset (a desktop/web/CLI turn that
 * never carried a channel message) or the internal `vellum` channel — belong
 * to the guardian owner, so they resume under
 * {@link INTERNAL_GUARDIAN_TRUST_CONTEXT}: the trust class `loadFromDb` needs
 * to rehydrate their guardian-provenance history instead of filtering it to
 * empty. Any other origin returns `null` so the caller skips the resume rather
 * than run the turn under a fabricated context — which would either grant a
 * low-trust turn guardian capability or bury the reply under `unknown`
 * provenance.
 */
function recoverRestingTrustContext(
  conversationId: string,
): TrustContext | null {
  const originChannel = getConversationOriginChannel(conversationId);
  if (originChannel === null || originChannel === "vellum") {
    return INTERNAL_GUARDIAN_TRUST_CONTEXT;
  }
  return null;
}

/**
 * Clear every stale processing flag and, when `resumeEnabled` is set, pick the
 * conversations to resume together with the resting trust each wake runs
 * under. Conversations whose resting trust can't be recovered are cleared but
 * skipped. The resume-attempt counter is NOT bumped here — it is charged as
 * each wake starts (see {@link resumeInterruptedConversations}), so a crash
 * mid-resume never burns the budget of conversations that were never attempted.
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
    return { cleared, resume: [], capped: [], trustUnrecoverable: [] };
  }
  const resume: InterruptedResumeTarget[] = [];
  const capped: string[] = [];
  const trustUnrecoverable: string[] = [];
  for (const row of interrupted) {
    if (row.resumeAttempts >= MAX_RESUME_ATTEMPTS) {
      capped.push(row.id);
      continue;
    }
    const trustContext = recoverRestingTrustContext(row.id);
    if (!trustContext) {
      trustUnrecoverable.push(row.id);
      continue;
    }
    resume.push({ conversationId: row.id, trustContext });
  }
  return { cleared, resume, capped, trustUnrecoverable };
}

/**
 * Resume interrupted conversations sequentially through the conversation
 * wake machinery. Sequential on purpose: a boot after a mid-turn crash can
 * carry several interrupted conversations, and running them one at a time
 * avoids a thundering herd of concurrent LLM turns right after startup.
 *
 * The persisted resume-attempt counter is bumped immediately before each
 * conversation's wake — never up-front for the whole batch — so a resume that
 * takes the process down again only charges the conversation actually being
 * attempted, leaving the rest of the budget intact across the next boots.
 *
 * Each wake runs clientless (background policy: side-effecting tools are
 * denied at the default threshold instead of stalling on an absent client)
 * under the conversation's reconstructed resting trust ({@link
 * InterruptedResumeTarget}), so resuming a conversation can never grant it more
 * capability than its own resting trust. Failures are logged and skipped so
 * one bad conversation doesn't block the rest.
 *
 * `agent-wake` is imported lazily: this module is loaded during early daemon
 * startup, and the wake machinery statically pulls in the agent-loop stack,
 * which must not join the lifecycle import graph (daemon ↔ runtime cycles).
 */
export async function resumeInterruptedConversations(
  targets: InterruptedResumeTarget[],
): Promise<void> {
  const { wakeAgentForOpportunity } = await import("../runtime/agent-wake.js");
  for (const { conversationId, trustContext } of targets) {
    // Charge the attempt as the wake begins, before the turn runs. The cap
    // exists to stop a resumed turn that keeps killing the process, so the
    // counter must be durably incremented before that turn can crash the
    // daemon; a sequential increment here also means a crash mid-resume never
    // charges the conversations still queued behind it.
    incrementProcessingResumeAttempts(conversationId);
    try {
      const result = await wakeAgentForOpportunity({
        conversationId,
        hint: INTERRUPTED_TURN_RESUME_HINT,
        source: "interrupted-turn-resume",
        trustContext,
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
