/**
 * Watch and call notifier registration/unregistration, extracted from
 * the Session constructor and dispose/abort methods.
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
import type { ServerMessage } from "./ipc-protocol.js";
import type { TrustContext } from "./session-runtime-assembly.js";
import {
  lastCommentaryBySession,
  lastSummaryBySession,
} from "./watch-handler.js";

/**
 * Subset of Session state that notifier callbacks need to read at
 * invocation time. Properties are read lazily from this reference.
 */
export interface NotifierSessionContext {
  sendToClient: (msg: ServerMessage) => void;
  messages: Message[];
  trustContext?: TrustContext;
}

/**
 * Register watch and call notifiers for a session. Call once during
 * construction; the notifier callbacks close over `ctx` so they see
 * live sendToClient/messages values.
 */
export function registerSessionNotifiers(
  conversationId: string,
  ctx: NotifierSessionContext,
): void {
  registerWatchStartNotifier(conversationId, (session: WatchSession) => {
    ctx.sendToClient({
      type: "watch_started",
      sessionId: conversationId,
      watchId: session.watchId,
      durationSeconds: session.durationSeconds,
      intervalSeconds: session.intervalSeconds,
    });
  });

  registerWatchCommentaryNotifier(conversationId, (_session: WatchSession) => {
    const commentary = lastCommentaryBySession.get(conversationId);
    if (commentary) {
      lastCommentaryBySession.delete(conversationId);
      ctx.sendToClient({
        type: "assistant_text_delta",
        text: commentary,
        sessionId: conversationId,
      });
      ctx.sendToClient({
        type: "message_complete",
        sessionId: conversationId,
      });
    }
  });

  registerWatchCompletionNotifier(conversationId, (_session: WatchSession) => {
    const summary = lastSummaryBySession.get(conversationId);
    if (summary) {
      lastSummaryBySession.delete(conversationId);
      ctx.sendToClient({
        type: "assistant_text_delta",
        text: summary,
        sessionId: conversationId,
      });
      ctx.sendToClient({
        type: "message_complete",
        sessionId: conversationId,
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
        sessionId: conversationId,
      });
      ctx.sendToClient({
        type: "message_complete",
        sessionId: conversationId,
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
        sessionId: conversationId,
      });
      ctx.sendToClient({
        type: "message_complete",
        sessionId: conversationId,
      });
    },
  );

  registerCallCompletionNotifier(conversationId, (callSessionId: string) => {
    const summaryText = buildCallCompletionMessage(callSessionId);

    ctx.sendToClient({
      type: "assistant_text_delta",
      text: summaryText,
      sessionId: conversationId,
    });
    ctx.sendToClient({
      type: "message_complete",
      sessionId: conversationId,
    });
  });
}

/**
 * Unregister watch notifiers and prune watch sessions. Called during
 * abort when the session is actively processing.
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
