import type { ServerMessage } from "../../daemon/message-protocol.js";

// ---------------------------------------------------------------------------
// Temporary fix — remove when #31994 lands
// ---------------------------------------------------------------------------
//
// The canned-response paths (canned greeting, inline approval reply, slash
// command, /compact, /clean, summarize-up-to) bypass the agent loop and so
// don't pick up the per-turn anchor id allocated in
// conversation-agent-loop.ts. Their `message_complete` events therefore went
// out without `messageId`, and the macOS client filter at
// ChatActionHandler.swift:507 dropped those events when they raced past the
// 50 ms streaming-buffer flush — leaving `isSending` stuck for the full 60 s
// watchdog window.
//
// Centralized so the patch surface is one helper + N one-line callers rather
// than N duplicated literals. When #31994 lands and stamps these sites with
// `state.assistantTurnId` directly, grep for `emitCannedMessageComplete` to
// find every call site and inline-then-delete.
export function emitCannedMessageComplete(
  send: (msg: ServerMessage) => void,
  conversationId: string,
  persistedAssistantId: string,
): void {
  send({
    type: "message_complete",
    conversationId,
    messageId: persistedAssistantId,
  });
}
