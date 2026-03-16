import type {
  ContentBlock,
  Message,
  ServerToolUseContent,
  ToolResultContent,
  ToolUseContent,
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
  // tool_result blocks stripped from assistant messages, keyed by tool_use_id
  let recoveredResults = new Map<string, ToolResultContent>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      // If previous assistant had unfulfilled tool_use, inject user message
      // using recovered results where available, synthetic for the rest
      if (pendingToolUseIds.size > 0) {
        result.push(
          buildResultMessage(pendingToolUseIds, recoveredResults, stats),
        );
        pendingToolUseIds = new Set();
        recoveredResults = new Map();
      }

      // Strip client-side tool_result blocks from assistant messages,
      // preserving them so they can be migrated to the correct user message.
      // Server-side tools (server_tool_use / web_search_tool_result) are
      // self-paired within the assistant message and must NOT be separated.
      const cleanedContent: ContentBlock[] = [];
      const newRecovered = new Map<string, ToolResultContent>();
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          // guard:allow-tool-result-only — only client-side tool_result belongs in recovered; web_search_tool_result stays in the assistant message
          const tr = block as ToolResultContent;
          newRecovered.set(tr.tool_use_id, tr);
          stats.assistantToolResultsMigrated++;
        } else {
          cleanedContent.push(block);
        }
      }

      // Ensure every server_tool_use has a paired web_search_tool_result
      // in the same assistant message (handles interrupted streams)
      const serverToolIds = new Set(
        cleanedContent
          .filter(
            (b): b is ServerToolUseContent => b.type === "server_tool_use",
          )
          .map((b) => b.id),
      );
      const matchedServerIds = new Set(
        cleanedContent
          .filter((b) => b.type === "web_search_tool_result")
          .map((b) => (b as { tool_use_id: string }).tool_use_id),
      );
      for (const id of serverToolIds) {
        if (!matchedServerIds.has(id)) {
          cleanedContent.push({
            type: "web_search_tool_result",
            tool_use_id: id,
            content: SYNTHETIC_WEB_SEARCH_ERROR,
          });
          stats.missingToolResultsInserted++;
        }
      }

      result.push({ role: "assistant", content: cleanedContent });

      // Only track client-side tool_use IDs as pending (not server_tool_use)
      pendingToolUseIds = new Set(
        cleanedContent
          .filter((b): b is ToolUseContent => b.type === "tool_use")
          .map((b) => b.id),
      );
      recoveredResults = newRecovered;
    } else {
      // User message
      if (pendingToolUseIds.size > 0) {
        const matchedIds = new Set<string>();
        const newContent: ContentBlock[] = [];

        for (const block of msg.content) {
          if (block.type === "tool_result") {
            // guard:allow-tool-result-only — matches client-side tool_use; web_search_tool_result is handled separately below
            const tr = block as ToolResultContent;
            if (pendingToolUseIds.has(tr.tool_use_id)) {
              matchedIds.add(tr.tool_use_id);
              newContent.push(block);
            } else {
              stats.orphanToolResultsDowngraded++;
              newContent.push(downgradeResult(tr));
            }
          } else if (block.type === "web_search_tool_result") {
            // web_search_tool_result in a user message is orphaned — server-side
            // results belong in the assistant message, not here
            stats.orphanToolResultsDowngraded++;
            newContent.push(
              downgradeResult(
                block as {
                  type: "web_search_tool_result";
                  tool_use_id: string;
                  content: unknown;
                },
              ),
            );
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
              newContent.push({
                type: "tool_result",
                tool_use_id: id,
                content: SYNTHETIC_RESULT,
                is_error: true,
              });
            }
          }
        }

        result.push({ role: "user", content: newContent });
        pendingToolUseIds = new Set();
        recoveredResults = new Map();
      } else {
        // No pending tool_use — any tool_result/web_search_tool_result here is orphaned
        const newContent: ContentBlock[] = msg.content.map((block) => {
          if (block.type === "tool_result") {
            stats.orphanToolResultsDowngraded++;
            return downgradeResult(block as ToolResultContent);
          }
          if (block.type === "web_search_tool_result") {
            stats.orphanToolResultsDowngraded++;
            return downgradeResult(
              block as {
                type: "web_search_tool_result";
                tool_use_id: string;
                content: unknown;
              },
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
    result.push(buildResultMessage(pendingToolUseIds, recoveredResults, stats));
  }

  // Merge consecutive same-role messages. This can occur after a checkpoint
  // handoff where a user(tool_result) message is followed by a user(new_message),
  // or from other history reconstruction artifacts. The Anthropic API requires
  // strict user/assistant alternation, so consecutive same-role messages must
  // always be merged. Undo semantics for mixed tool_result+text messages are
  // handled by isUndoableUserMessage in conversation.ts.
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
  recovered: Map<string, ToolResultContent>,
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

function downgradeResult(tr: {
  type: string;
  tool_use_id: string;
  content?: unknown;
}): ContentBlock {
  const content =
    tr.type === "tool_result" ? tr.content : "[web search result]"; // guard:allow-tool-result-only — distinguishes content format between the two types
  return {
    type: "text",
    text: `[orphaned ${tr.type} for ${tr.tool_use_id}]: ${content}`,
  };
}
