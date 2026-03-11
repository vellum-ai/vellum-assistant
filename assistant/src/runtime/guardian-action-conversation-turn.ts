/**
 * Guardian follow-up conversation engine.
 *
 * When a guardian replies to a post-timeout follow-up prompt (e.g. "would you
 * like to call them back?"), this engine classifies the
 * guardian's intent into a structured disposition and produces a natural reply.
 *
 * Dispositions:
 *   - call_back:     Guardian wants to call the original caller back
 *   - decline:       Guardian declines to follow up ("never mind", "no thanks")
 *   - keep_pending:  Intent is ambiguous — ask for clarification
 *
 * The engine uses the daemon-injected generator (LLM with tool calling) when
 * available, with a safe fallback that keeps the follow-up pending and returns
 * a retry prompt.
 */

import { getLogger } from "../util/logger.js";
import { getGuardianActionFallbackMessage } from "./guardian-action-message-composer.js";
import type {
  GuardianFollowUpConversationContext,
  GuardianFollowUpConversationGenerator,
  GuardianFollowUpDisposition,
  GuardianFollowUpTurnResult,
} from "./http-types.js";

const log = getLogger("guardian-action-conversation-turn");

// ---------------------------------------------------------------------------
// Fallback text
// ---------------------------------------------------------------------------

const FALLBACK_RETRY_TEXT = getGuardianActionFallbackMessage({
  scenario: "guardian_followup_clarification",
});

const VALID_DISPOSITIONS: ReadonlySet<string> = new Set([
  "call_back",
  "decline",
  "keep_pending",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Process one turn of the guardian follow-up conversation.
 *
 * Uses the daemon-injected generator when available; on failure or absence,
 * returns a safe keep_pending result with a retry prompt so the follow-up
 * stays open for the guardian to try again.
 */
export async function processGuardianFollowUpTurn(
  context: GuardianFollowUpConversationContext,
  generator?: GuardianFollowUpConversationGenerator,
): Promise<GuardianFollowUpTurnResult> {
  if (!generator) {
    log.warn(
      "No guardian follow-up conversation generator available, using fallback",
    );
    return { disposition: "keep_pending", replyText: FALLBACK_RETRY_TEXT };
  }

  try {
    const result = await generator(context);

    // Validate the generator's output
    if (
      !result ||
      typeof result.replyText !== "string" ||
      result.replyText.trim().length === 0
    ) {
      log.warn(
        "Guardian follow-up generator returned invalid result (missing replyText)",
      );
      return { disposition: "keep_pending", replyText: FALLBACK_RETRY_TEXT };
    }

    if (!VALID_DISPOSITIONS.has(result.disposition)) {
      log.warn(
        { disposition: result.disposition },
        "Guardian follow-up generator returned invalid disposition",
      );
      return { disposition: "keep_pending", replyText: FALLBACK_RETRY_TEXT };
    }

    return {
      disposition: result.disposition as GuardianFollowUpDisposition,
      replyText: result.replyText.trim(),
    };
  } catch (err) {
    log.warn(
      { err },
      "Guardian follow-up conversation generator failed, using fallback",
    );
    return { disposition: "keep_pending", replyText: FALLBACK_RETRY_TEXT };
  }
}
