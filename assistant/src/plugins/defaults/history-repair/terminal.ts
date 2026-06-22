/**
 * Default `history-repair` behavior: the implementation that normalizes a
 * message history so it satisfies the provider's tool-use/tool-result pairing
 * and role-alternation rules.
 *
 * This module is side-effect free: importing it does not register any plugin.
 * `repairHistory` is the canonical repair pass, run per turn via the plugin's
 * `user-prompt-submit` hook (`./hooks/user-prompt-submit.ts`) and exported so
 * daemon call sites and tests can reach it directly. `deepRepairHistory` is an
 * aggressive one-shot fallback applied after a provider ordering rejection, and
 * `isRepairableOrderingError` recognizes the rejections it can recover — so
 * detection and repair of ordering drift live together as one unit.
 */

import type {
  ContentBlock,
  Message,
  ServerToolUseContent,
  ToolResultContent,
  ToolUseContent,
} from "../../../providers/types.js";

interface RepairStats {
  assistantToolResultsMigrated: number;
  missingToolResultsInserted: number;
  orphanToolResultsDowngraded: number;
  consecutiveSameRoleMerged: number;
}

interface RepairResult {
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

      // Pair server-side tool blocks within the same assistant message.
      // Server tools (e.g. web_search) emit server_tool_use + matching
      // web_search_tool_result. Either side can go missing — the synthetic
      // result is inserted IMMEDIATELY AFTER the orphan server_tool_use (not
      // appended to the end) so ensureToolPairing's split at tool_use
      // boundaries cannot separate the pair. An orphan
      // web_search_tool_result (no preceding server_tool_use) is downgraded
      // to text — Anthropic rejects the request otherwise.
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
      const orphanedServerIds = new Set<string>();
      for (const id of serverToolIds) {
        if (!matchedServerIds.has(id)) {
          orphanedServerIds.add(id);
        }
      }
      const orphanedWebSearchResultIds = new Set<string>();
      for (const id of matchedServerIds) {
        if (!serverToolIds.has(id)) {
          orphanedWebSearchResultIds.add(id);
        }
      }

      let repairedContent: ContentBlock[];
      if (orphanedServerIds.size > 0 || orphanedWebSearchResultIds.size > 0) {
        repairedContent = [];
        for (const block of cleanedContent) {
          if (
            block.type === "web_search_tool_result" &&
            orphanedWebSearchResultIds.has(
              (block as { tool_use_id: string }).tool_use_id,
            )
          ) {
            repairedContent.push(
              downgradeResult(
                block as {
                  type: "web_search_tool_result";
                  tool_use_id: string;
                  content: unknown;
                },
              ),
            );
            stats.orphanToolResultsDowngraded++;
            continue;
          }
          repairedContent.push(block);
          if (
            block.type === "server_tool_use" &&
            orphanedServerIds.has(block.id)
          ) {
            repairedContent.push({
              type: "web_search_tool_result",
              tool_use_id: block.id,
              content: SYNTHETIC_WEB_SEARCH_ERROR,
            });
            stats.missingToolResultsInserted++;
          }
        }
      } else {
        repairedContent = cleanedContent;
      }

      result.push({ role: "assistant", content: repairedContent });

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

function downgradeResult(tr: {
  type: string;
  tool_use_id: string;
  content?: unknown;
}): ContentBlock {
  const content =
    tr.type === "tool_result" ? tr.content : formatWebSearchContent(tr.content); // guard:allow-tool-result-only — distinguishes content format between the two types
  return {
    type: "text",
    text: `[orphaned ${tr.type} for ${tr.tool_use_id}]: ${content}`,
  };
}

function formatWebSearchContent(content: unknown): string {
  if (Array.isArray(content)) {
    const entries: string[] = [];
    for (const r of content) {
      if (
        typeof r !== "object" ||
        r == null ||
        (r as { type?: string }).type !== "web_search_result"
      ) {
        continue;
      }
      const title =
        typeof (r as { title?: unknown }).title === "string"
          ? (r as { title: string }).title
          : "(untitled)";
      const url =
        typeof (r as { url?: unknown }).url === "string"
          ? (r as { url: string }).url
          : "";
      const idx = entries.length + 1;
      entries.push(url ? `${idx}. ${title}\n   ${url}` : `${idx}. ${title}`);
    }
    if (entries.length > 0) return entries.join("\n");
  }
  return "results unavailable";
}

/**
 * Provider rejection messages indicating a tool_use/tool_result pairing or
 * message-ordering violation — the structural drift `deepRepairHistory`
 * re-normalizes.
 */
export const ORDERING_ERROR_PATTERNS: readonly RegExp[] = [
  /tool_result.*not immediately after.*tool_use/i,
  /tool_use.*must have.*tool_result/i,
  /tool_use_id.*without.*tool_result/i,
  /tool_result.*tool_use_id.*not found/i,
  /messages.*invalid.*order/i,
];

/**
 * Provider rejection messages for the server-side web-search tool's own
 * tool_use/result pairing violations, which `repairHistory` resolves by
 * downgrading the orphaned block to text.
 */
export const WEB_SEARCH_ORDERING_PATTERNS: readonly RegExp[] = [
  /web_search.*tool_use.*without/i,
  /web_search.*tool_result/i,
];

/**
 * Whether a provider error message denotes an ordering/pairing violation that
 * `deepRepairHistory` can recover by re-normalizing the history. Detection and
 * repair are co-located so callers recognize and fix ordering drift through a
 * single source of truth.
 */
export function isRepairableOrderingError(message: string): boolean {
  return (
    ORDERING_ERROR_PATTERNS.some((pattern) => pattern.test(message)) ||
    WEB_SEARCH_ORDERING_PATTERNS.some((pattern) => pattern.test(message))
  );
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
