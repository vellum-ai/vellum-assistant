// Single source of truth for pairing server-side tool blocks (e.g. native
// web_search) across a message list. Pure leaf module: consumed by the
// provider formatter, load-time history repair, and any other pass that must
// distinguish a genuine orphan from a pair the provider manages itself.

/**
 * Minimal structural message shape shared by daemon `Message[]` and
 * `Anthropic.MessageParam[]`.
 */
export interface ServerToolPairingMessage {
  role: string;
  content: string | ReadonlyArray<unknown>;
}

/** Type-guard for server_tool_use blocks. */
export function isServerToolUseBlock(
  block: unknown,
): block is { type: "server_tool_use"; id: string; name: string } {
  return (
    typeof block === "object" &&
    block != null &&
    (block as { type: string }).type === "server_tool_use"
  );
}

/** Type-guard for web_search_tool_result blocks. */
export function isWebSearchToolResultBlock(block: unknown): block is {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: unknown;
} {
  return (
    typeof block === "object" &&
    block != null &&
    (block as { type: string }).type === "web_search_tool_result"
  );
}

function isToolResultShapedBlock(block: unknown): boolean {
  return (
    typeof block === "object" &&
    block != null &&
    (block as { type?: string }).type === "tool_result"
  );
}

function contentBlocks(msg: ServerToolPairingMessage): ReadonlyArray<unknown> {
  return Array.isArray(msg.content) ? msg.content : [];
}

/**
 * Pairing analysis for server-side tool blocks across the whole message list.
 *
 * Server-side tools are provider-executed, and the pair can legitimately span
 * messages: when the model requests a server tool and a client tool in the
 * same parallel tool-call group, the API defers the search (stop_reason
 * `tool_use`, no result emitted) and executes it on the next request, placing
 * the web_search_tool_result at the head of the next assistant message. Both
 * the deferred tail and the resulting split pair must be sent back verbatim
 * for the provider to pair and execute them.
 */
export interface ServerToolPairing {
  /**
   * Ids with a complete use/result pair: the server_tool_use appears in the
   * same message as its web_search_tool_result or in an earlier one.
   */
  resolvedPairIds: Set<string>;
  /**
   * Unanswered use ids in the final assistant message of an active tool-loop
   * continuation (only user messages after it, carrying tool_result blocks or
   * nothing at all). The provider executes these on this request.
   */
  deferredUseIds: Set<string>;
  /** Ids whose use/result pair spans two messages. */
  crossMessageIds: Set<string>;
}

export function analyzeServerToolPairing(
  messages: ReadonlyArray<ServerToolPairingMessage>,
): ServerToolPairing {
  const useIndexById = new Map<string, number>();
  const resultIndexById = new Map<string, number>();
  let lastAssistantIndex = -1;

  messages.forEach((msg, index) => {
    if (msg.role !== "assistant") {
      // Server-tool blocks legitimately live only in assistant messages; a
      // stray result in a user message is a repair concern, not a pair.
      return;
    }
    lastAssistantIndex = index;
    for (const block of contentBlocks(msg)) {
      if (isServerToolUseBlock(block) && !useIndexById.has(block.id)) {
        useIndexById.set(block.id, index);
      }
      if (
        isWebSearchToolResultBlock(block) &&
        !resultIndexById.has(block.tool_use_id)
      ) {
        resultIndexById.set(block.tool_use_id, index);
      }
    }
  });

  const resolvedPairIds = new Set<string>();
  const crossMessageIds = new Set<string>();
  useIndexById.forEach((useIndex, id) => {
    const resultIndex = resultIndexById.get(id);
    if (resultIndex !== undefined && resultIndex >= useIndex) {
      resolvedPairIds.add(id);
      if (resultIndex > useIndex) {
        crossMessageIds.add(id);
      }
    }
  });

  const deferredUseIds = new Set<string>();
  if (lastAssistantIndex >= 0) {
    const trailing = messages.slice(lastAssistantIndex + 1);
    const trailingAllUser = trailing.every((m) => m.role === "user");
    const trailingHasToolResult = trailing.some((m) =>
      contentBlocks(m).some(isToolResultShapedBlock),
    );
    if (trailingAllUser && (trailing.length === 0 || trailingHasToolResult)) {
      for (const block of contentBlocks(messages[lastAssistantIndex])) {
        if (isServerToolUseBlock(block) && !resolvedPairIds.has(block.id)) {
          deferredUseIds.add(block.id);
        }
      }
    }
  }

  return { resolvedPairIds, deferredUseIds, crossMessageIds };
}
