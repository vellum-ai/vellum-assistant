/**
 * Promote a parked `ask_question` prompt into a guardian request and notify
 * the guardian through the notification pipeline.
 *
 * Called fire-and-forget by {@link QuestionPrompter} right after it registers
 * the pending `question` interaction, mirroring how confirmations are promoted
 * (`confirmation-guardian-request.ts`). The request row makes the question
 * answerable on channels: the notification broadcaster renders the options as
 * card actions, and a tap / request-code reply / bare text routes back through
 * the guardian reply router to the `pending_question` resolver, which settles
 * the parked interaction.
 *
 * Gating — inverted from the confirmation bridge, which escalates a
 * NON-guardian's confirmation TO the guardian:
 *  - `ask_question` targets whoever is chatting, so promotion only makes sense
 *    when the chatter IS the guardian (the pipeline delivers to the guardian's
 *    own channels — the same chat they're in). Non-guardian turns keep the
 *    tool's plain-text fallback.
 *  - Only single-question batches promote: one card, one answer, one resolve.
 *  - Only channel turns promote (`channelSupportsGuardianQuestionCards`):
 *    app turns already render the SSE question card, and voice turns have
 *    their own pending-question dispatch in the calls domain.
 *
 * The heavy dependencies are loaded lazily so importing this module — and
 * therefore the prompter — stays cheap and free of import-time side effects.
 */

import type { QuestionRequestEvent } from "../api/events/question-request.js";
import { getConfig } from "../config/loader.js";
import { channelSupportsGuardianQuestionCards } from "../daemon/channel-ui-capability.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("question-guardian-request");

/**
 * Create a `pending_question` guardian request + notification for a parked
 * `ask_question` prompt, when the turn qualifies (see module doc). Safe to
 * call fire-and-forget; failures are logged, never thrown — the prompt still
 * resolves via the app card or times out.
 */
export async function createGuardianRequestForQuestion(
  msg: QuestionRequestEvent,
  conversationId: string,
): Promise<void> {
  try {
    if (msg.questions.length !== 1) {
      return;
    }

    const [
      { findConversation },
      { createGuardianRequest, expireGuardianRequest },
      { bridgeQuestionRequestToGuardian },
    ] = await Promise.all([
      import("../daemon/conversation-registry.js"),
      import("../channels/gateway-guardian-requests.js"),
      import("../runtime/question-request-guardian-bridge.js"),
    ]);

    const conversation = findConversation(conversationId);
    // The prompter runs inside the emitting turn — bind to the turn's trust
    // snapshot so a concurrent context mutation can't repoint the request.
    const trustContext =
      conversation?.currentTurnTrustContext ?? conversation?.trustContext;
    if (!conversation || !trustContext) {
      return;
    }

    const sourceChannel = trustContext.sourceChannel;
    if (!channelSupportsGuardianQuestionCards(sourceChannel)) {
      return;
    }
    if (trustContext.trustClass !== "guardian") {
      return;
    }
    // Questions are answerable only by the bound guardian principal.
    const guardianPrincipalId = trustContext.guardianPrincipalId;
    if (!guardianPrincipalId) {
      log.warn(
        { conversationId, requestId: msg.requestId, sourceChannel },
        "Skipping question guardian request: guardian turn has no bound principal",
      );
      return;
    }

    const entry = msg.questions[0]!;
    const guardianRequest = await createGuardianRequest({
      id: msg.requestId,
      kind: "pending_question",
      sourceChannel,
      sourceConversationId: conversationId,
      requesterExternalUserId: trustContext.requesterExternalUserId,
      requesterChatId: trustContext.requesterChatId ?? undefined,
      guardianExternalUserId: trustContext.guardianExternalUserId,
      guardianPrincipalId,
      questionText: entry.question,
      status: "pending",
      expiresAt:
        Date.now() + getConfig().timeouts.questionResponseTimeoutSec * 1000,
    });

    // The prompt is answerable via the app card before this fire-and-forget
    // create lands; if it already resolved, expire the fresh row instead of
    // stranding a decidable request for a settled prompt.
    const { get: getPendingInteraction } =
      await import("../runtime/pending-interactions.js");
    const pending = getPendingInteraction(msg.requestId);
    if (!pending || pending.kind !== "question") {
      await expireGuardianRequest(guardianRequest.id);
      log.info(
        { conversationId, requestId: msg.requestId },
        "Question resolved before its guardian request landed; expired the row",
      );
      return;
    }

    await bridgeQuestionRequestToGuardian({
      guardianRequest,
      trustContext,
      conversationId,
      question: entry,
    });
  } catch (err) {
    log.warn(
      { err, conversationId, requestId: msg.requestId },
      "Failed to create guardian request for question; channel answers will not work for it",
    );
  }
}
