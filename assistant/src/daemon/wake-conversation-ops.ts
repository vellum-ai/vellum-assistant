/**
 * Daemon-side side effects a wake performs against a live
 * {@link Conversation}, used by `wakeAgentForOpportunity()` in
 * `runtime/agent-wake.ts`.
 *
 * These are kept as standalone functions (rather than methods on
 * `Conversation`) so the wake-specific concerns — event→wire translation,
 * the wake ui_surface card, and the wake's one-shot tail persistence —
 * stay out of the conversation class. They live in the daemon layer
 * because they translate agent-loop events into client wire frames and
 * touch the message store, so `runtime/agent-wake.ts` references only the
 * erased `Conversation` type and never imports `message-protocol.ts`.
 */

import type { AgentEvent } from "../agent/loop.js";
import {
  addMessage,
  getConversation,
  provenanceFromTrustContext,
} from "../memory/conversation-crud.js";
import { syncMessageToDisk } from "../memory/conversation-disk-view.js";
import { backfillMessageIdOnLogs } from "../memory/llm-request-log-store.js";
import type { Message } from "../providers/types.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import type { Conversation } from "./conversation.js";
import type { ServerMessage } from "./message-protocol.js";
import type {
  SubagentToolGateMode,
  WakeToolContextPin,
} from "./tool-setup-types.js";

const log = getLogger("wake-conversation-ops");

/**
 * Translate a raw {@link AgentEvent} from the agent loop into the
 * corresponding {@link ServerMessage} wire frame. The normal user-turn
 * path does this via the full state-aware handler in
 * `conversation-agent-loop-handlers.ts`; the wake path has no tool
 * accounting, title generation, or activity-state tracking to worry
 * about, so we only need the subset that produces client-visible
 * frames. Events that have no client-visible wire shape (usage, error,
 * preview/input-json deltas, etc.) are dropped — they produce no UI.
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
    case "provider_error":
    case "max_tokens_reached":
    case "context_compacting":
    case "compaction_circuit_open":
    case "compaction_circuit_closed":
    case "compaction_completed":
    case "history_stripped":
    case "agent_loop_exit":
      return null;
    case "llm_call_started":
      // The wake path persists its assistant tail via
      // `persistWakeTailMessage` (an `addMessage`-shaped call) rather than
      // the main event-handler's `reserve` → `updateContent` pipeline, so
      // there is no row to reserve here. Translation returns null and the
      // wake path's existing end-of-turn persist continues to mint the row.
      return null;
  }
}

/**
 * Translate a raw agent event to its wire frame and broadcast it to
 * connected clients. No-op for events with no client-visible shape.
 */
export function emitWakeAgentEvent(
  conversation: Conversation,
  event: AgentEvent,
): void {
  const frame = translateAgentEventToServerMessage(
    event,
    conversation.conversationId,
  );
  if (!frame) return;
  broadcastMessage(frame);
}

/**
 * Emit the live ui_surface card announcing that a wake produced output.
 * The `surfaceId` matches the `ui_surface` content block injected into
 * the wake's first assistant tail message so the client renders one card,
 * not two.
 */
export function broadcastWakeSurface(
  conversation: Conversation,
  source: string,
  hint: string,
  surfaceId: string,
): void {
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
}

/**
 * Persist a single tail message produced by a wake (assistant outputs and
 * intervening tool_result user messages). Builds the channel/interface
 * metadata, persists via the canonical `addMessage` path, syncs the row to
 * the disk view, and backfills the message id onto this turn's LLM request
 * logs so wake-produced messages match the user-turn persistence path.
 */
export async function persistWakeTailMessage(
  conversation: Conversation,
  message: Message,
): Promise<void> {
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
    { metadata },
  );
  if (message.role === "assistant") {
    try {
      backfillMessageIdOnLogs(conversation.conversationId, persisted.id);
    } catch (err) {
      log.warn(
        { err, conversationId: conversation.conversationId },
        "wake persist: backfill messageId on LLM logs failed (non-fatal)",
      );
    }
  }
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
      "wake persist: syncMessageToDisk failed (non-fatal)",
    );
  }
}

/**
 * Temporarily restrict the tools visible/executable during a wake by
 * reusing the conversation's subagent allowlist slot. Returns a restore
 * callback that reinstates the previous allowlist so the wake can release
 * the scope before any queued user turn is drained.
 *
 * `gateMode` controls how the allowlist is enforced — see
 * {@link SubagentToolGateMode}. `toolContextPin`, when provided
 * (execution-gate-mode cache-parity wakes), freezes the client-context
 * inputs for tool-definition resolution — see {@link WakeToolContextPin}.
 * Both are set and restored alongside the allowlist.
 */
export function scopeWakeAllowedTools(
  conversation: Conversation,
  tools: ReadonlySet<string>,
  gateMode: SubagentToolGateMode = "wire",
  toolContextPin?: WakeToolContextPin,
): () => void {
  const previous = conversation.subagentAllowedTools;
  const previousGateMode = conversation.subagentToolGateMode;
  const previousToolContextPin = conversation.toolContextPin;
  conversation.setSubagentAllowedTools(new Set(tools));
  conversation.subagentToolGateMode = gateMode;
  conversation.toolContextPin = toolContextPin;
  return () => {
    conversation.setSubagentAllowedTools(previous);
    conversation.subagentToolGateMode = previousGateMode;
    conversation.toolContextPin = previousToolContextPin;
  };
}
