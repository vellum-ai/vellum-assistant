/**
 * Tool-call updaters for SSE stream events.
 *
 * Handles: tool_use_start, tool_result, tool_output_chunk.
 *
 * Each exported function has the signature
 * `(prev: DisplayMessage[], ...args) => DisplayMessage[]`.
 */

import type { DisplayMessage } from "@/domains/chat/types/types";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";
import type { ConversationContentBlock } from "@vellumai/assistant-api";
import type {
  AllowlistOption,
  DirectoryScopeOption,
  RiskScopeOption,
} from "@/types/interaction-ui-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ToolActivityMetadata } from "@/assistant/web-activity-types";
import {
  tailIsAssistant,
  findAssistantRowIndexByMessageId,
  withMergedAlias,
} from "@/domains/chat/utils/stream-updaters/shared";

// ---------------------------------------------------------------------------
// tool_use_start
// ---------------------------------------------------------------------------

/**
 * Insert or update the `tool_use` block carrying `toolCall` (matched by id),
 * so the `contentBlocks` projection stays in lockstep with the positional
 * `toolCalls` array as the call streams from start through result.
 */
function upsertToolUseBlock(
  blocks: ConversationContentBlock[] | undefined,
  toolCall: ChatMessageToolCall,
): ConversationContentBlock[] {
  const next = [...(blocks ?? [])];
  const existingIdx = next.findIndex(
    (b) => b.type === "tool_use" && b.toolCall.id === toolCall.id,
  );
  if (existingIdx === -1) {
    next.push({ type: "tool_use", toolCall });
  } else {
    next[existingIdx] = { type: "tool_use", toolCall };
  }
  return next;
}

/**
 * Fold a tool call into the assistant row at `idx`, either updating the
 * existing entry (same `toolCall.id`) or appending a new one with a
 * matching `contentOrder` entry. The `contentBlocks` `tool_use` entry is
 * upserted in lockstep so a live row matches its re-ingested history shape.
 */
function upsertToolCallIntoRow(
  prev: DisplayMessage[],
  idx: number,
  toolCall: ChatMessageToolCall,
  messageId?: string,
): DisplayMessage[] {
  const row = withMergedAlias(prev[idx]!, messageId);
  const existingIdx =
    row.toolCalls?.findIndex((tc) => tc.id === toolCall.id) ?? -1;
  const updated = [...prev];

  if (existingIdx !== -1) {
    const updatedToolCalls = [...(row.toolCalls ?? [])];
    const merged = { ...updatedToolCalls[existingIdx]!, ...toolCall };
    updatedToolCalls[existingIdx] = merged;
    updated[idx] = {
      ...row,
      toolCalls: updatedToolCalls,
      contentBlocks: upsertToolUseBlock(row.contentBlocks, merged),
    };
    return updated;
  }

  updated[idx] = {
    ...row,
    toolCalls: [...(row.toolCalls ?? []), toolCall],
    contentOrder: [
      ...(row.contentOrder ?? []),
      { type: "toolCall", id: toolCall.id },
    ],
    contentBlocks: upsertToolUseBlock(row.contentBlocks, toolCall),
  };
  return updated;
}

/**
 * Insert or update a tool call on the current assistant bubble, creating a
 * new bubble only when the tail isn't an assistant row.
 *
 * **Identity-keyed when `messageId` is present** — looks up the assistant
 * row that owns the id (primary id or merged alias) and folds into it
 * regardless of position. Mirrors `appendTextDelta`: when no row owns the
 * id yet, the tool call belongs to a later LLM call in the current agent
 * turn, so it folds into the assistant tail (recording the id as an alias)
 * to keep the turn one bubble rather than splitting per call. Only a
 * non-assistant tail opens a fresh bubble.
 *
 * Falls back to tail-based decisioning when `messageId` is absent, for
 * pre-anchor-protocol daemons.
 */
export function upsertToolCall(
  prev: DisplayMessage[],
  toolCall: ChatMessageToolCall,
  messageId?: string,
  at: number = Date.now(),
): DisplayMessage[] {
  if (messageId) {
    const idx = findAssistantRowIndexByMessageId(prev, messageId);
    if (idx >= 0) return upsertToolCallIntoRow(prev, idx, toolCall, messageId);
    if (tailIsAssistant(prev)) {
      return upsertToolCallIntoRow(prev, prev.length - 1, toolCall, messageId);
    }
  } else if (tailIsAssistant(prev)) {
    return upsertToolCallIntoRow(prev, prev.length - 1, toolCall);
  }

  return [
    ...prev,
    {
      id: messageId ?? crypto.randomUUID(),
      ...(messageId ? {} : { isOptimistic: true }),
      role: "assistant" as const,
      toolCalls: [toolCall],
      contentOrder: [{ type: "toolCall", id: toolCall.id }],
      contentBlocks: [{ type: "tool_use", toolCall }],
      timestamp: at,
    },
  ];
}

// ---------------------------------------------------------------------------
// tool_result
// ---------------------------------------------------------------------------

/** Apply a tool result to the matching tool call. */
export function applyToolResult(
  prev: DisplayMessage[],
  opts: {
    toolUseId?: string;
    result?: string;
    isError?: boolean;
    riskLevel?: string;
    riskReason?: string;
    matchedTrustRuleId?: string;
    approvalMode?: string;
    approvalReason?: string;
    riskThreshold?: string;
    riskAllowlistOptions?: AllowlistOption[];
    riskScopeOptions?: RiskScopeOption[];
    riskDirectoryScopeOptions?: DirectoryScopeOption[];
    imageData?: string;
    imageDataList?: string[];
    /**
     * Structured activity metadata from the tool_result event. Persisted on
     * the tool call so web-search steps can keep rendering after the active
     * turn ends and `liveWebActivity` is cleared.
     */
    activityMetadata?: ToolActivityMetadata;
    /**
     * Server-stamped completion time (ms). Keeps the final duration on the
     * same clock as the daemon-stamped `startedAt`; falls back to the local
     * clock for older daemons that omit it.
     */
    completedAt?: number;
  },
): DisplayMessage[] {
  let msgIdx = -1;
  let tcIdx = -1;

  if (opts.toolUseId) {
    for (let i = prev.length - 1; i >= 0; i--) {
      const m = prev[i];
      if (m?.role !== "assistant" || !m.toolCalls?.length) continue;
      const j = m.toolCalls.findIndex((tc) => tc.id === opts.toolUseId);
      if (j !== -1) {
        msgIdx = i;
        tcIdx = j;
        break;
      }
    }
  }

  if (msgIdx === -1) {
    msgIdx = prev.findLastIndex(
      (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
    );
    if (msgIdx === -1) return prev;
    const msg = prev[msgIdx];
    if (!msg?.toolCalls) return prev;
    tcIdx = msg.toolCalls.findLastIndex((tc) => isToolCallRunning(tc));
  }

  if (tcIdx === -1) return prev;

  const msg = prev[msgIdx]!;
  const existingTc = msg.toolCalls![tcIdx];
  if (!existingTc) return prev;

  const imageDataList =
    opts.imageDataList !== undefined
      ? opts.imageDataList
      : opts.imageData !== undefined
        ? [opts.imageData]
        : undefined;
  const imageData =
    opts.imageData !== undefined ? opts.imageData : imageDataList?.[0];
  const updatedToolCalls = [...msg.toolCalls!];
  const updatedTc = {
    ...existingTc,
    result: opts.result,
    isError: opts.isError,
    riskLevel: opts.riskLevel,
    riskReason: opts.riskReason,
    matchedTrustRuleId: opts.matchedTrustRuleId,
    approvalMode: opts.approvalMode,
    approvalReason: opts.approvalReason,
    riskThreshold: opts.riskThreshold,
    riskAllowlistOptions: opts.riskAllowlistOptions,
    riskScopeOptions: opts.riskScopeOptions,
    riskDirectoryScopeOptions: opts.riskDirectoryScopeOptions,
    ...(imageData !== undefined ? { imageData } : {}),
    ...(imageDataList !== undefined ? { imageDataList } : {}),
    ...(opts.activityMetadata !== undefined
      ? { activityMetadata: opts.activityMetadata }
      : {}),
    completedAt: opts.completedAt ?? Date.now(),
    // The final result supersedes the live stream tail; drop it to free memory
    // and so renderers prefer the complete `result`.
    streamedOutput: undefined,
  };
  updatedToolCalls[tcIdx] = updatedTc;

  const updated = [...prev];
  updated[msgIdx] = {
    ...msg,
    toolCalls: updatedToolCalls,
    contentBlocks: upsertToolUseBlock(msg.contentBlocks, updatedTc),
  };
  return updated;
}

// ---------------------------------------------------------------------------
// tool_output_chunk
// ---------------------------------------------------------------------------

/**
 * Max chars of live streamed output retained per tool call. Foreground bash
 * stdout/stderr can flood; we keep only a bounded tail for the drawer preview
 * — the complete, untruncated output still arrives once via `tool_result`
 * (`result`). Bounding caps both memory and the per-flush re-render cost.
 */
export const MAX_STREAMED_OUTPUT_CHARS = 16_384;

function boundedTail(text: string): string {
  return text.length <= MAX_STREAMED_OUTPUT_CHARS
    ? text
    : text.slice(text.length - MAX_STREAMED_OUTPUT_CHARS);
}

/**
 * Append an incremental `tool_output_chunk` onto the matching tool call's live
 * `streamedOutput` tail. Correlation mirrors `applyToolResult`: narrow to the
 * `messageId` row when present, prefer the `toolUseId` id match (back-to-front),
 * else fall back to the last running tool call. The `contentBlocks` `tool_use`
 * entry is updated in lockstep so either slice reads the same live tail.
 */
export function appendToolOutputChunk(
  prev: DisplayMessage[],
  opts: { chunk: string; toolUseId?: string; messageId?: string },
): DisplayMessage[] {
  if (!opts.chunk) return prev;

  let msgIdx = -1;
  let tcIdx = -1;

  if (opts.toolUseId) {
    // id-based correlation only. `messageId` narrows the owning row first;
    // otherwise scan back-to-front for the id. We deliberately do NOT fall
    // back to a positional "last running tool" when the id isn't present: a
    // chunk whose id is absent belongs to a tool in another (e.g.
    // switched-away) conversation, and a positional match would misattribute
    // it to an unrelated running tool.
    if (opts.messageId) {
      const rowIdx = findAssistantRowIndexByMessageId(prev, opts.messageId);
      if (rowIdx >= 0) {
        const j =
          prev[rowIdx]!.toolCalls?.findIndex((tc) => tc.id === opts.toolUseId) ??
          -1;
        if (j !== -1) {
          msgIdx = rowIdx;
          tcIdx = j;
        }
      }
    }
    if (msgIdx === -1) {
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m?.role !== "assistant" || !m.toolCalls?.length) continue;
        const j = m.toolCalls.findIndex((tc) => tc.id === opts.toolUseId);
        if (j !== -1) {
          msgIdx = i;
          tcIdx = j;
          break;
        }
      }
    }
  } else {
    // Pre-anchor daemons omit `toolUseId`: attribute to the last running tool
    // call in the latest assistant row (same-conversation by construction).
    msgIdx = prev.findLastIndex(
      (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
    );
    if (msgIdx === -1) return prev;
    const msg = prev[msgIdx];
    if (!msg?.toolCalls) return prev;
    tcIdx = msg.toolCalls.findLastIndex((tc) => isToolCallRunning(tc));
  }

  if (msgIdx === -1 || tcIdx === -1) return prev;

  const msg = prev[msgIdx]!;
  const existingTc = msg.toolCalls![tcIdx];
  if (!existingTc) return prev;

  const updatedTc = {
    ...existingTc,
    streamedOutput: boundedTail((existingTc.streamedOutput ?? "") + opts.chunk),
  };
  const updatedToolCalls = [...msg.toolCalls!];
  updatedToolCalls[tcIdx] = updatedTc;

  const updated = [...prev];
  updated[msgIdx] = {
    ...msg,
    toolCalls: updatedToolCalls,
    contentBlocks: upsertToolUseBlock(msg.contentBlocks, updatedTc),
  };
  return updated;
}
