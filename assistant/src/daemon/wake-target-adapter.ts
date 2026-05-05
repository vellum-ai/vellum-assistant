/**
 * Adapter that wraps a live {@link Conversation} as a {@link WakeTarget}
 * for `wakeAgentForOpportunity()`.
 *
 * Extracted from `server.ts` so that `runtime/agent-wake.ts` can import
 * the resolver directly instead of going through a DI callback registered
 * at daemon startup.
 */

import type { AgentEvent } from "../agent/loop.js";
import {
  addMessage,
  getConversation,
  provenanceFromTrustContext,
} from "../memory/conversation-crud.js";
import { syncMessageToDisk } from "../memory/conversation-disk-view.js";
import type { WakeTarget } from "../runtime/agent-wake.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import type { Conversation } from "./conversation.js";
import type { ServerMessage } from "./message-protocol.js";

const log = getLogger("wake-target-adapter");

/**
 * Translate a raw {@link AgentEvent} from the agent loop into the
 * corresponding {@link ServerMessage} wire frame. The normal user-turn
 * path does this via the full state-aware handler in
 * `conversation-agent-loop-handlers.ts`; the wake path has no tool
 * accounting, title generation, or activity-state tracking to worry
 * about, so we only need the subset that produces client-visible
 * frames. Events that have no client-visible wire shape (usage, error,
 * preview/input-json deltas, etc.) are dropped — they produce no UI.
 *
 * Keeping this translator co-located with the wake adapter preserves
 * the runtime/daemon layering: `runtime/agent-wake.ts` never imports
 * `message-protocol.ts` or wire shapes, and the daemon owns all
 * translation from agent-loop semantics to client frames.
 */
function translateAgentEventToServerMessage(
  event: AgentEvent,
  conversationId: string,
): ServerMessage | null {
  switch (event.type) {
    case "text_delta":
      return {
        type: "assistant_text_delta",
        text: event.text,
        conversationId,
      };
    case "thinking_delta":
      return {
        type: "assistant_thinking_delta",
        thinking: event.thinking,
        conversationId,
      };
    case "tool_use":
      return {
        type: "tool_use_start",
        toolName: event.name,
        input: event.input,
        conversationId,
        toolUseId: event.id,
      };
    case "tool_use_preview_start":
      return {
        type: "tool_use_preview_start",
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        conversationId,
      };
    case "tool_output_chunk":
      return {
        type: "tool_output_chunk",
        chunk: event.chunk,
        conversationId,
        toolUseId: event.toolUseId,
      };
    case "tool_result": {
      const imageBlocks = event.contentBlocks?.filter(
        (b): b is Extract<typeof b, { type: "image" }> => b.type === "image",
      );
      const imageDataList = imageBlocks?.length
        ? imageBlocks.map((b) => b.source.data)
        : undefined;
      return {
        type: "tool_result",
        toolName: "",
        result: event.content,
        isError: event.isError,
        diff: event.diff,
        status: event.status,
        conversationId,
        imageData: imageDataList?.[0],
        imageDataList,
        toolUseId: event.toolUseId,
      };
    }
    case "server_tool_start":
      return {
        type: "tool_use_start",
        toolName: event.name,
        input: event.input,
        conversationId,
        toolUseId: event.toolUseId,
      };
    case "server_tool_complete": {
      let resultText = "";
      if (Array.isArray(event.content) && event.content.length > 0) {
        resultText = (event.content as unknown[])
          .filter(
            (r): r is { type: string; title: string; url: string } =>
              typeof r === "object" &&
              r != null &&
              (r as { type?: string }).type === "web_search_result",
          )
          .map((r) => `${r.title}\n${r.url}`)
          .join("\n\n");
      }
      return {
        type: "tool_result",
        toolName: "web_search",
        result: resultText,
        isError: event.isError,
        conversationId,
        toolUseId: event.toolUseId,
      };
    }
    case "message_complete":
      return {
        type: "message_complete",
        conversationId,
      };
    case "input_json_delta":
    case "usage":
    case "error":
      return null;
  }
}

/**
 * Adapt a live {@link Conversation} to the narrow {@link WakeTarget}
 * surface expected by `wakeAgentForOpportunity()`.
 */
export function conversationToWakeTarget(
  conversation: Conversation,
): WakeTarget {
  return {
    conversationId: conversation.conversationId,
    agentLoop: conversation.agentLoop,
    getMessages: () => conversation.getMessages(),
    pushMessage: (msg) => {
      conversation.messages.push(msg);
    },
    onWakeProducedOutput: (source, hint, surfaceId) => {
      broadcastMessage({
        type: "ui_surface_show",
        conversationId: conversation.conversationId,
        surfaceId,
        surfaceType: "card",
        data: {
          title: "Conversation Woke",
          body: hint,
          metadata: [{ label: "Source", value: source }],
        },
        display: "inline",
      });
    },
    emitAgentEvent: (event) => {
      const frame = translateAgentEventToServerMessage(
        event,
        conversation.conversationId,
      );
      if (!frame) return;
      broadcastMessage(frame);
    },
    isProcessing: () => conversation.isProcessing(),
    markProcessing: (on) => {
      conversation.processing = on;
    },
    setTrustContext: (ctx) => conversation.setTrustContext(ctx),
    persistTailMessage: async (message) => {
      const turnChannelCtx = conversation.getTurnChannelContext();
      const turnInterfaceCtx = conversation.getTurnInterfaceContext();
      const metadata: Record<string, unknown> = {
        ...provenanceFromTrustContext(conversation.trustContext),
        userMessageChannel: turnChannelCtx?.userMessageChannel ?? "vellum",
        assistantMessageChannel:
          turnChannelCtx?.assistantMessageChannel ?? "vellum",
        userMessageInterface: turnInterfaceCtx?.userMessageInterface ?? "web",
        assistantMessageInterface:
          turnInterfaceCtx?.assistantMessageInterface ?? "web",
      };
      const persisted = await addMessage(
        conversation.conversationId,
        message.role,
        JSON.stringify(message.content),
        metadata,
      );
      try {
        const convRow = getConversation(conversation.conversationId);
        if (convRow) {
          syncMessageToDisk(
            conversation.conversationId,
            persisted.id,
            convRow.createdAt,
          );
        }
      } catch (err) {
        log.warn(
          { err, conversationId: conversation.conversationId },
          "wake adapter: syncMessageToDisk failed (non-fatal)",
        );
      }
    },
    drainQueue: () => conversation.drainQueue(),
  };
}
