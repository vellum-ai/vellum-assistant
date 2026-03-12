import type {
  ContentBlock,
  Message,
  ServerToolUseContent,
  ToolResultContent,
  ToolUseContent,
  WebSearchToolResultContent,
} from "../providers/types.js";

export interface RepairStats {
  assistantToolResultsMigrated: number;
  missingToolResultsInserted: number;
  orphanToolResultsDowngraded: number;
  consecutiveSameRoleMerged: number;
}

export interface RepairResult {
  messages: Message[];
  stats: RepairStats;
}

const SYNTHETIC_RESULT =
  "<synthesized_result>tool result missing from history</synthesized_result>";

const SYNTHETIC_WEB_SEARCH_ERROR = {
  type: "web_search_tool_result_error",
  error_code: "unavailable",
};

export function repairHistory(messages: Message[]): RepairResult {
  const stats: RepairStats = {
    assistantToolResultsMigrated: 0,
    missingToolResultsInserted: 0,
    orphanToolResultsDowngraded: 0,
    consecutiveSameRoleMerged: 0,
  };

  const result: Message[] = [];
  let pendingToolUseIds = new Set<string>();
  // IDs of server_tool_use blocks (need web_search_tool_result, not tool_result)
  let serverToolUseIds = new Set<string>();
  // tool_result/web_search_tool_result blocks stripped from assistant messages, keyed by tool_use_id
  let recoveredResults = new Map<
    string,
    ToolResultContent | WebSearchToolResultContent
  >();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      // If previous assistant had unfulfilled tool_use, inject user message
      // using recovered results where available, synthetic for the rest
      if (pendingToolUseIds.size > 0) {
        result.push(
          buildResultMessage(
            pendingToolUseIds,
            serverToolUseIds,
            recoveredResults,
            stats,
          ),
        );
        pendingToolUseIds = new Set();
        serverToolUseIds = new Set();
        recoveredResults = new Map();
      }

      // Strip tool_result/web_search_tool_result blocks from assistant messages,
      // preserving them so they can be migrated to the correct user message position
      const cleanedContent: ContentBlock[] = [];
      const newRecovered = new Map<
        string,
        ToolResultContent | WebSearchToolResultContent
      >();
      for (const block of msg.content) {
        if (
          block.type === "tool_result" ||
          block.type === "web_search_tool_result"
        ) {
          const tr = block as ToolResultContent | WebSearchToolResultContent;
          newRecovered.set(tr.tool_use_id, tr);
          stats.assistantToolResultsMigrated++;
        } else {
          cleanedContent.push(block);
        }
      }

      result.push({ role: "assistant", content: cleanedContent });

      // Collect tool_use and server_tool_use IDs from this assistant message
      pendingToolUseIds = new Set(
        cleanedContent
          .filter(
            (b): b is ToolUseContent | ServerToolUseContent =>
              b.type === "tool_use" || b.type === "server_tool_use",
          )
          .map((b) => b.id),
      );
      serverToolUseIds = new Set(
        cleanedContent
          .filter(
            (b): b is ServerToolUseContent => b.type === "server_tool_use",
          )
          .map((b) => b.id),
      );
      recoveredResults = newRecovered;
    } else {
      // User message
      if (pendingToolUseIds.size > 0) {
        const matchedIds = new Set<string>();
        const newContent: ContentBlock[] = [];

        for (const block of msg.content) {
          if (
            block.type === "tool_result" ||
            block.type === "web_search_tool_result"
          ) {
            const tr = block as ToolResultContent | WebSearchToolResultContent;
            const isTypeMatch = pendingToolUseIds.has(tr.tool_use_id) &&
              (block.type === "web_search_tool_result") === serverToolUseIds.has(tr.tool_use_id);
            if (isTypeMatch) {
              matchedIds.add(tr.tool_use_id);
              newContent.push(block);
            } else {
              stats.orphanToolResultsDowngraded++;
              newContent.push(downgradeResult(tr));
            }
          } else {
            newContent.push(block);
          }
        }

        // Fill unmatched IDs: use recovered results if available, otherwise synthesize
        for (const id of pendingToolUseIds) {
          if (!matchedIds.has(id)) {
            const recovered = recoveredResults.get(id);
            if (recovered) {
              newContent.push(recovered);
              // Already counted in assistantToolResultsMigrated
            } else {
              stats.missingToolResultsInserted++;
              if (serverToolUseIds.has(id)) {
                newContent.push({
                  type: "web_search_tool_result",
                  tool_use_id: id,
                  content: SYNTHETIC_WEB_SEARCH_ERROR,
                });
              } else {
                newContent.push({
                  type: "tool_result",
                  tool_use_id: id,
                  content: SYNTHETIC_RESULT,
                  is_error: true,
                });
              }
            }
          }
        }

        result.push({ role: "user", content: newContent });
        pendingToolUseIds = new Set();
        serverToolUseIds = new Set();
        recoveredResults = new Map();
      } else {
        // No pending tool_use — any tool_result/web_search_tool_result here is orphaned
        const newContent: ContentBlock[] = msg.content.map((block) => {
          if (
            block.type === "tool_result" ||
            block.type === "web_search_tool_result"
          ) {
            stats.orphanToolResultsDowngraded++;
            return downgradeResult(
              block as ToolResultContent | WebSearchToolResultContent,
            );
          }
          return block;
        });

        result.push({ role: "user", content: newContent });
      }
    }
  }

  // Trailing unfulfilled tool_use at end of history
  if (pendingToolUseIds.size > 0) {
    result.push(
      buildResultMessage(
        pendingToolUseIds,
        serverToolUseIds,
        recoveredResults,
        stats,
      ),
    );
  }

  // Merge consecutive same-role messages. This can occur after a checkpoint
  // handoff where a user(tool_result) message is followed by a user(new_message),
  // or from other history reconstruction artifacts. The Anthropic API requires
  // strict user/assistant alternation, so consecutive same-role messages must
  // always be merged. Undo semantics for mixed tool_result+text messages are
  // handled by isUndoableUserMessage in session.ts.
  const merged: Message[] = [];
  for (const msg of result) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = [...prev.content, ...msg.content];
      stats.consecutiveSameRoleMerged++;
    } else {
      merged.push({ role: msg.role, content: [...msg.content] });
    }
  }

  return { messages: merged, stats };
}

function buildResultMessage(
  ids: Set<string>,
  serverIds: Set<string>,
  recovered: Map<string, ToolResultContent | WebSearchToolResultContent>,
  stats: RepairStats,
): Message {
  return {
    role: "user",
    content: Array.from(ids).map((id) => {
      const rec = recovered.get(id);
      if (rec) {
        // Already counted in assistantToolResultsMigrated
        return rec;
      }
      stats.missingToolResultsInserted++;
      if (serverIds.has(id)) {
        return {
          type: "web_search_tool_result" as const,
          tool_use_id: id,
          content: SYNTHETIC_WEB_SEARCH_ERROR,
        };
      }
      return {
        type: "tool_result" as const,
        tool_use_id: id,
        content: SYNTHETIC_RESULT,
        is_error: true,
      };
    }),
  };
}

/**
 * Aggressive repair pass that handles edge cases beyond repairHistory:
 * - Removes empty messages
 * - Ensures the first message is from the user
 * - Merges consecutive same-role messages (before tool-use/result repair)
 * Then applies the standard repairHistory on top (which also merges any
 * consecutive same-role messages introduced by tool-use/result repair).
 */
export function deepRepairHistory(messages: Message[]): RepairResult {
  // 1. Remove messages with no content blocks
  let cleaned = messages.filter((m) => m.content.length > 0);

  // 2. Strip leading assistant messages (provider requires user-first)
  while (cleaned.length > 0 && cleaned[0].role === "assistant") {
    cleaned = cleaned.slice(1);
  }

  // 3. Merge consecutive same-role messages
  const merged: Message[] = [];
  for (const msg of cleaned) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = [...prev.content, ...msg.content];
    } else {
      merged.push({ role: msg.role, content: [...msg.content] });
    }
  }

  // 4. Apply standard tool-use/tool-result repair on top
  return repairHistory(merged);
}

function downgradeResult(
  tr: ToolResultContent | WebSearchToolResultContent,
): ContentBlock {
  const content =
    tr.type === "tool_result" ? tr.content : "[web search result]"; // guard:allow-tool-result-only — distinguishes content format between the two types
  return {
    type: "text",
    text: `[orphaned ${tr.type} for ${tr.tool_use_id}]: ${content}`,
  };
}
