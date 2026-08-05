/**
 * Shared wire-serialization rule for OpenAI tool results.
 *
 * Both OpenAI transports reject a tool result whose call was never emitted
 * earlier in the same request: chat-completions rejects a `tool`-role message
 * whose `tool_call_id` has no preceding assistant `tool_calls` entry, and the
 * Responses API rejects a `function_call_output` whose `call_id` has no
 * preceding `function_call`. Both therefore serialize a result as its native
 * paired item only on a backward match, and degrade an unmatched one into
 * plain text carried by the accompanying user message.
 *
 * The text payload and the orphan decision are identical across the two
 * transports, so they live here; only the paired wire shape (and which media
 * kinds each transport accepts alongside it) differs, and that stays at the
 * call sites.
 *
 * Distinct from `agent/history-repair`'s `[orphaned <type> for <id>]:` marker,
 * which operates one layer up on persisted history: it repairs the stored
 * conversation shape (naming the id, and covering `web_search_tool_result`
 * too) before any transport is chosen. This marker means "the call never
 * reached this request's wire payload", so the id it would name is absent by
 * construction. Keeping the two readable apart tells an operator which layer
 * degraded the block.
 */

import type { ContentBlock, ToolResultContent } from "../types.js";

/** Text prefix marking a tool result whose call is absent from the request. */
const ORPHANED_MARKER = "[orphaned tool result]";

/** Text prefix marking a tool result the executor reported as failed. */
const ERROR_MARKER = "[ERROR]";

/**
 * How a tool result should be serialized for an OpenAI transport:
 *
 * - `paired`: its call was emitted earlier in this request, so the transport
 *   emits its native tool-output item carrying `payload`.
 * - `orphaned`: no matching call, so `block` is folded into the user message
 *   instead of being sent as a rejectable tool-output item.
 */
export type ToolResultSerialization =
  | { kind: "paired"; payload: string }
  | { kind: "orphaned"; block: ContentBlock };

/**
 * Flatten a tool result's text (its own `content` plus any text in
 * `contentBlocks`), mark executor failures, and decide whether the request
 * can carry it as a paired tool-output item.
 *
 * `emittedCallIds` holds the ids already emitted as calls earlier in the same
 * request, so membership is a backward match by construction. Media in
 * `contentBlocks` is not consulted: each transport accepts a different set and
 * collects it separately.
 */
export function serializeToolResult(
  toolResult: ToolResultContent,
  emittedCallIds: ReadonlySet<string>,
): ToolResultSerialization {
  let text = toolResult.content;
  const extraText = (toolResult.contentBlocks ?? [])
    .filter(
      (cb): cb is Extract<ContentBlock, { type: "text" }> => cb.type === "text",
    )
    .map((cb) => cb.text);
  if (extraText.length > 0) {
    text = text + "\n" + extraText.join("\n");
  }

  const payload = toolResult.is_error ? `${ERROR_MARKER} ${text}` : text;

  if (!emittedCallIds.has(toolResult.tool_use_id)) {
    return {
      kind: "orphaned",
      block: { type: "text", text: `${ORPHANED_MARKER} ${payload}` },
    };
  }
  return { kind: "paired", payload };
}
