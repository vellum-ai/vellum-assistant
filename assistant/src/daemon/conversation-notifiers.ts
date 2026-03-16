/**
 * Watch and call notifier registration/unregistration, extracted from
 * the Conversation constructor and dispose/abort methods.
 *
 * Notifier callbacks read from the provided context object at invocation
 * time (not registration time), so they always see the latest sendToClient
 * and messages references even after updateClient().
 */

import { createAssistantMessage } from "../agent/message-types.js";
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
} from "../memory/conversation-crud.js";
import type { Message } from "../providers/types.js";
import type { WatchSession } from "../tools/watch/watch-state.js";
import {
  pruneWatchSessions,
  registerWatchCommentaryNotifier,
  registerWatchCompletionNotifier,
  registerWatchStartNotifier,
  unregisterWatchCommentaryNotifier,
  unregisterWatchCompletionNotifier,
  unregisterWatchStartNotifier,
} from "../tools/watch/watch-state.js";
import type { TrustContext } from "./conversation-runtime-assembly.js";
import type { ServerMessage } from "./message-protocol.js";
import {
  lastCommentaryByConversation,
  lastSummaryByConversation,
} from "./watch-handler.js";

/**
 * Subset of Conversation state that notifier callbacks need to read at
 * invocation time. Properties are read lazily from this reference.
 */
export interface NotifierConversationContext {
  sendToClient: (msg: ServerMessage) => void;
  messages: Message[];
  trustContext?: TrustContext;
}

/**
 * Register watch and call notifiers for a conversation. Call once during
 * construction; the notifier callbacks close over `ctx` so they see
 * live sendToClient/messages values.
 */
export function registerConversationNotifiers(
  conversationId: string,
  ctx: NotifierConversationContext,
): void {
  registerWatchStartNotifier(conversationId, (session: WatchSession) => {
    ctx.sendToClient({
      type: "watch_started",
      conversationId: conversationId,
      watchId: session.watchId,
      durationSeconds: session.durationSeconds,
      intervalSeconds: session.intervalSeconds,
    });
  });

  registerWatchCommentaryNotifier(conversationId, (_session: WatchSession) => {
    const commentary = lastCommentaryByConversation.get(conversationId);
    if (commentary) {
      lastCommentaryByConversation.delete(conversationId);
      ctx.sendToClient({
        type: "assistant_text_delta",
        text: commentary,
        conversationId: conversationId,
      });
      ctx.sendToClient({
        type: "message_complete",
        conversationId: conversationId,
      });
    }
  });

  registerWatchCompletionNotifier(conversationId, (_session: WatchSession) => {
    const summary = lastSummaryByConversation.get(conversationId);
    if (summary) {
      lastSummaryByConversation.delete(conversationId);
      ctx.sendToClient({
        type: "assistant_text_delta",
        text: summary,
        conversationId: conversationId,
      });
      ctx.sendToClient({
        type: "message_complete",
        conversationId: conversationId,
      });
    }
  });

  registerCallQuestionNotifier(
    conversationId,
    async (callSessionId: string, question: string) => {
      const callSession = getCallSession(callSessionId);
      const callee = callSession?.toNumber ?? "the caller";
      const questionText = `**Live call question** (to ${callee}):\n\n${question}\n\n_Use the call answer API to respond._`;

      await addMessage(
        conversationId,
        "assistant",
        JSON.stringify([{ type: "text", text: questionText }]),
        {
          ...provenanceFromTrustContext(ctx.trustContext),
          userMessageChannel: "phone",
          assistantMessageChannel: "phone",
          userMessageInterface: "phone",
          assistantMessageInterface: "phone",
        },
      );

      ctx.messages.push(createAssistantMessage(questionText));

      ctx.sendToClient({
        type: "assistant_text_delta",
        text: questionText,
        conversationId: conversationId,
      });
      ctx.sendToClient({
        type: "message_complete",
        conversationId: conversationId,
      });
    },
  );

  registerCallTranscriptNotifier(
    conversationId,
    (_callSessionId: string, speaker: "caller" | "assistant", text: string) => {
      const speakerLabel = speaker === "caller" ? "Caller" : "Assistant";
      const transcriptText = `**Live call transcript**\n${speakerLabel}: ${text}`;

      ctx.sendToClient({
        type: "assistant_text_delta",
        text: transcriptText,
        conversationId: conversationId,
      });
      ctx.sendToClient({
        type: "message_complete",
        conversationId: conversationId,
      });
    },
  );

  registerCallCompletionNotifier(conversationId, (callSessionId: string) => {
    const summaryText = buildCallCompletionMessage(callSessionId);

    ctx.sendToClient({
      type: "assistant_text_delta",
      text: summaryText,
      conversationId: conversationId,
    });
    ctx.sendToClient({
      type: "message_complete",
      conversationId: conversationId,
    });
  });
}

/**
 * Unregister watch notifiers and prune watch sessions. Called during
 * abort when the conversation is actively processing.
 */
export function unregisterWatchNotifiers(conversationId: string): void {
  unregisterWatchStartNotifier(conversationId);
  unregisterWatchCommentaryNotifier(conversationId);
  unregisterWatchCompletionNotifier(conversationId);
  pruneWatchSessions(conversationId);
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
