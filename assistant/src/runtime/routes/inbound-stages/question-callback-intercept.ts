/**
 * Stage 1 of channel question handling: intercept a `qst:` wizard tap.
 *
 * A tap on an `ask_question` option button arrives as `callbackData`
 * (`qst:<requestId>:<questionId>:<optionIndex|skip>`, set as the message content
 * by the gateway). This stage records the answer against the wizard and returns
 * `handled` so the inbound handler returns early — a `qst:` callback must never
 * reach the agent as literal text, whether it's fresh or stale.
 *
 * Outbound advance/finalize is the watcher's job (channel-questions.ts + the
 * background-dispatch watcher own the single outbound message); this stage only
 * mutates wizard state.
 */
import { getLogger } from "../../../util/logger.js";
import {
  getPendingQuestionInfoByConversation,
  recordQuestionTap,
} from "../../channel-questions.js";
import { parseQuestionCallbackData } from "../channel-route-shared.js";

const log = getLogger("runtime-http");

export interface QuestionCallbackInterceptParams {
  conversationId: string;
  callbackData?: string;
}

export interface QuestionCallbackInterceptResult {
  /** `true` when the callback was a `qst:` tap — the caller returns early. */
  handled: boolean;
  /** Outcome for logging / seen-signal wording. */
  type?: "answer_recorded" | "answer_completed" | "stale_ignored";
}

/**
 * Record a `qst:` wizard tap. Returns `{ handled: false }` when the callback is
 * not a question tap (so other inbound stages run); otherwise always
 * `{ handled: true }` — a well-formed `qst:` callback is consumed here even when
 * stale (no matching pending question, out-of-order, or bad index).
 */
export function handleQuestionCallbackIntercept(
  params: QuestionCallbackInterceptParams,
): QuestionCallbackInterceptResult {
  const { conversationId, callbackData } = params;
  if (!callbackData) return { handled: false };

  const parsed = parseQuestionCallbackData(callbackData);
  if (!parsed) return { handled: false };

  // Scope the tap to a pending question for THIS conversation. A stale button
  // from a resolved (or different) conversation is consumed and ignored, never
  // applied to another pending question.
  const pendingForConversation =
    getPendingQuestionInfoByConversation(conversationId);
  if (!pendingForConversation.some((i) => i.requestId === parsed.requestId)) {
    log.info(
      { conversationId, requestId: parsed.requestId },
      "Question callback for no matching pending question; ignoring stale tap",
    );
    return { handled: true, type: "stale_ignored" };
  }

  const result = recordQuestionTap(
    parsed.requestId,
    parsed.questionId,
    parsed.selection,
  );
  if (result.status === "recorded") {
    return {
      handled: true,
      type: result.completed ? "answer_completed" : "answer_recorded",
    };
  }
  return { handled: true, type: "stale_ignored" };
}
