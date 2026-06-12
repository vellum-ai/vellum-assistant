/**
 * Rich transcript projection for the report UI.
 *
 * The persisted `transcript.json` only carries the *textual* turns
 * (simulator messages + assistant text), but the full event stream in
 * `assistant-events.json` also carries thinking deltas, tool calls,
 * tool results, and surfaces. This module folds that event stream into
 * per-assistant-message content blocks using the same concatenation
 * semantics as the web chat UI (`apps/web/src/domains/chat/utils/
 * stream-updaters/message-updaters.ts`):
 *
 *  - consecutive deltas of the same kind coalesce into the trailing
 *    block; a kind switch opens a new block, preserving interleaving
 *    order (thinking → tool → thinking → text renders as four blocks);
 *  - `tool_use_start` opens a running tool-call block that the matching
 *    `tool_result` completes (matched by `toolUseId` when both sides
 *    carry it, else the oldest still-running call — the Vellum daemon's
 *    `tool_result` omits the id);
 *  - a simulator turn closes the current assistant message, so each
 *    assistant message spans exactly one reply.
 *
 * Pure data → data so it's unit-testable and shared by every renderer.
 */

import type { AgentEvent } from "./adapter";
import type { TranscriptTurn } from "./transcript";

export type AssistantBlock =
  | { kind: "thinking"; thinking: string }
  | { kind: "text"; text: string }
  | {
      kind: "tool_call";
      toolName: string;
      toolUseId?: string;
      input?: unknown;
      result?: string;
      isError?: boolean;
      status: "running" | "completed";
    }
  | { kind: "surface"; surfaceType: string; title?: string; data?: unknown };

export interface AssistantMessageView {
  role: "assistant";
  emittedAt?: string;
  blocks: AssistantBlock[];
}

export interface SimulatorTurnView {
  role: "simulator";
  emittedAt: string;
  content: string;
}

export type TranscriptViewItem = SimulatorTurnView | AssistantMessageView;

/**
 * Event types that contribute a content block to the assistant message.
 * Everything else in the stream (activity states, sync invalidations,
 * trace events, usage, echoes, …) is plumbing, not message content —
 * it stays visible in the raw "Container events" section.
 */
function blockForEvent(event: AgentEvent): AssistantBlock | undefined {
  const msg = event.message;
  const text = msg.text ?? msg.chunk;
  if (typeof text === "string" && text.length > 0) {
    return { kind: "text", text };
  }
  if (typeof msg.thinking === "string" && msg.thinking.length > 0) {
    return { kind: "thinking", thinking: msg.thinking };
  }
  if (msg.type === "tool_use_start") {
    return {
      kind: "tool_call",
      toolName: typeof msg.toolName === "string" ? msg.toolName : "tool",
      toolUseId: typeof msg.toolUseId === "string" ? msg.toolUseId : undefined,
      input: msg.input,
      status: "running",
    };
  }
  if (msg.type === "ui_surface_show") {
    return {
      kind: "surface",
      surfaceType:
        typeof msg.surfaceType === "string" ? msg.surfaceType : "surface",
      title: typeof msg.title === "string" ? msg.title : undefined,
      data: msg.data,
    };
  }
  return undefined;
}

/**
 * Complete the running tool-call block a `tool_result` event resolves.
 * Matches by `toolUseId` when the result carries one; otherwise the
 * oldest still-running call (tool results arrive in start order on a
 * single-threaded turn). A result with no open call is dropped — there
 * is no block to attach it to, and the raw event log still shows it.
 */
function applyToolResult(blocks: AssistantBlock[], event: AgentEvent): void {
  const msg = event.message;
  const toolUseId =
    typeof msg.toolUseId === "string" ? msg.toolUseId : undefined;
  const target = blocks.find(
    (block): block is Extract<AssistantBlock, { kind: "tool_call" }> =>
      block.kind === "tool_call" &&
      block.status === "running" &&
      (toolUseId === undefined || block.toolUseId === toolUseId),
  );
  if (!target) return;
  target.status = "completed";
  if (typeof msg.result === "string") target.result = msg.result;
  if (typeof msg.isError === "boolean") target.isError = msg.isError;
}

/**
 * Coalesce a delta block into the message, web-chat style: extend the
 * trailing block when it is the same kind, else append a new block.
 */
function appendBlock(message: AssistantMessageView, block: AssistantBlock) {
  const tail = message.blocks[message.blocks.length - 1];
  if (block.kind === "text" && tail?.kind === "text") {
    tail.text += block.text;
    return;
  }
  if (block.kind === "thinking" && tail?.kind === "thinking") {
    tail.thinking += block.thinking;
    return;
  }
  message.blocks.push(block);
}

/**
 * Build the interleaved transcript view: simulator turns from the
 * persisted transcript, assistant messages folded from the event
 * stream. Events and simulator turns merge chronologically on their
 * ISO `emittedAt` stamps. When the run has no persisted events (legacy
 * artifact dirs) or any event lacks a stamp (the Hermes adapter
 * synthesizes bare `message_chunk` events with no `emittedAt`, so the
 * stream can't be ordered against simulator turns), the persisted
 * turns render as plain text messages so turn order is never wrong.
 */
export function buildTranscriptView(
  turns: TranscriptTurn[],
  assistantEvents: AgentEvent[],
): TranscriptViewItem[] {
  if (
    assistantEvents.length === 0 ||
    assistantEvents.some((event) => event.emittedAt === undefined)
  ) {
    return turns.map((turn) =>
      turn.role === "simulator"
        ? {
            role: "simulator",
            emittedAt: turn.emittedAt,
            content: turn.content,
          }
        : {
            role: "assistant",
            emittedAt: turn.emittedAt,
            blocks: [{ kind: "text", text: turn.content }],
          },
    );
  }

  const simulatorTurns = turns.filter((turn) => turn.role === "simulator");
  const items: TranscriptViewItem[] = [];
  let current: AssistantMessageView | undefined;
  let simulatorIdx = 0;

  const flushSimulatorTurnsBefore = (emittedAt: string | undefined) => {
    while (simulatorIdx < simulatorTurns.length) {
      const turn = simulatorTurns[simulatorIdx];
      if (emittedAt !== undefined && turn.emittedAt > emittedAt) break;
      items.push({
        role: "simulator",
        emittedAt: turn.emittedAt,
        content: turn.content,
      });
      simulatorIdx += 1;
      current = undefined;
    }
  };

  for (const event of assistantEvents) {
    flushSimulatorTurnsBefore(event.emittedAt);

    if (event.message.type === "tool_result") {
      if (current) applyToolResult(current.blocks, event);
      continue;
    }

    const block = blockForEvent(event);
    if (!block) continue;

    if (!current) {
      current = { role: "assistant", emittedAt: event.emittedAt, blocks: [] };
      items.push(current);
    }
    appendBlock(current, block);
  }

  flushSimulatorTurnsBefore(undefined);
  return items;
}
