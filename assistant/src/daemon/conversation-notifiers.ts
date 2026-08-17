/**
 * Call notifier registration/unregistration, extracted from
 * the Conversation constructor and dispose/abort methods.
 *
 * Notifier callbacks read from the provided context object at invocation
 * time (not registration time), so they always see the latest messages
 * reference. They emit through the conversation, whose sink is fixed for its
 * life, so an out-of-turn notification reaches every subscribed client
 * without any per-turn wiring.
 */

import { createAssistantMessage } from "../agent/message-types.js";
import type { AssistantEvent } from "../api/index.js";
import { buildCallCompletionMessage } from "../calls/call-conversation-messages.js";
import {
  registerCallCompletionNotifier,
  registerCallQuestionNotifier,
  registerCallTranscriptNotifier,
  unregisterCallCompletionNotifier,
  unregisterCallQuestionNotifier,
  unregisterCallTranscriptNotifier,
} from "../calls/call-state.js";
import { getCallSession } from "../calls/call-store.js";
import {
  addMessage,
  provenanceFromTrustContext,
} from "../persistence/conversation-crud.js";
import type { Message } from "../providers/types.js";
import type { TrustContext } from "./trust-context-types.js";
import { restingTrust } from "./trust-context-types.js";

/**
 * Subset of Conversation state that notifier callbacks need to read at
 * invocation time. Properties are read lazily from this reference.
 */
export interface NotifierConversationContext {
  emit: (msg: AssistantEvent) => void;
  messages: Message[];
  trustContext?: TrustContext;
}

/**
 * Register call notifiers for a conversation. Call once during
 * construction; the notifier callbacks close over `ctx` so they see
 * live sendToClient/messages values.
 */
export function registerConversationNotifiers(
  conversationId: string,
  ctx: NotifierConversationContext,
): void {
  registerCallQuestionNotifier(
    conversationId,
    async (callSessionId: string, question: string) => {
      const callSession = getCallSession(callSessionId);
      const callee = callSession?.toNumber ?? "the caller";
      const questionText = `**Live call question** (to ${callee}):\n\n${question}\n\n_Use the call answer API to respond._`;

      const msg = await addMessage(
        conversationId,
        "assistant",
        JSON.stringify([{ type: "text", text: questionText }]),
        {
          metadata: {
            ...provenanceFromTrustContext(
              // This callback fires after the voice turn has settled: the
              // per-turn field may still hold that turn's actor (nothing
              // clears it at release), while voice cleanup has restored the
              // conversation's resting trust. The owner is the right actor
              // for a row persisted outside any turn.
              restingTrust(ctx),
            ),
            userMessageChannel: "phone",
            assistantMessageChannel: "phone",
            userMessageInterface: "phone",
            assistantMessageInterface: "phone",
          },
        },
      );

      ctx.messages.push(createAssistantMessage(questionText));

      ctx.emit({
        type: "assistant_text_delta",
        text: questionText,
        conversationId: conversationId,
      });
      ctx.emit({
        type: "message_complete",
        conversationId: conversationId,
        messageId: msg.id,
        source: "aux",
      });
    },
  );

  registerCallTranscriptNotifier(
    conversationId,
    (_callSessionId: string, speaker: "caller" | "assistant", text: string) => {
      const speakerLabel = speaker === "caller" ? "Caller" : "Assistant";
      const transcriptText = `**Live call transcript**\n${speakerLabel}: ${text}`;

      ctx.emit({
        type: "assistant_text_delta",
        text: transcriptText,
        conversationId: conversationId,
      });
      ctx.emit({
        type: "message_complete",
        conversationId: conversationId,
        source: "aux",
      });
    },
  );

  registerCallCompletionNotifier(conversationId, (callSessionId: string) => {
    const summaryText = buildCallCompletionMessage(callSessionId);

    ctx.emit({
      type: "assistant_text_delta",
      text: summaryText,
      conversationId: conversationId,
    });
    ctx.emit({
      type: "message_complete",
      conversationId: conversationId,
      source: "aux",
    });
  });
}

/**
 * Unregister call notifiers. Called during dispose regardless of
 * processing state (notifiers are registered in the constructor).
 */
export function unregisterCallNotifiers(conversationId: string): void {
  unregisterCallQuestionNotifier(conversationId);
  unregisterCallTranscriptNotifier(conversationId);
  unregisterCallCompletionNotifier(conversationId);
}
