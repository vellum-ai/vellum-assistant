/**
 * Default `history-repair` behavior: the implementation that normalizes a
 * message history so it satisfies the provider's tool-use/tool-result pairing
 * and role-alternation rules.
 *
 * This module is side-effect free: importing it does not register any plugin.
 * `repairHistory` is the canonical repair pass, run per turn via the plugin's
 * `user-prompt-submit` hook (`./hooks/user-prompt-submit.ts`) and exported so
 * daemon call sites and tests can reach it directly. `deepRepairHistory` is an
 * aggressive one-shot fallback the orchestrator invokes only after a provider
 * ordering error.
 */

import type {
  ContentBlock,
  Message,
  ServerToolUseContent,
  ToolResultContent,
  ToolUseContent,
} from "../../../providers/types.js";

export interface RepairStats {
  assistantToolResultsMigrated: number;
  missingToolResultsInserted: number;
  orphanToolResultsDowngraded: number;
  consecutiveSameRoleMerged: number;
}

export interface HistoryRepairActions {
  migratedAssistantToolResults: boolean;
  insertedSyntheticToolResults: boolean;
  repairedOrphanToolResults: boolean;
  mergedSameRoleMessages: boolean;
}

export interface HistoryRepairDiagnostics {
  stats: RepairStats;
  actions: HistoryRepairActions;
}

export interface HistoryTailMessageSummary {
  role: Message["role"];
  blockTypes: string[];
  textBlockCount: number;
  toolUseCount: number;
  toolResultCount: number;
  syntheticToolResultCount: number;
  orphanToolResultTextCount: number;
  serverToolUseCount: number;
  webSearchToolResultCount: number;
}

export interface HistoryTailSnapshot {
  totalMessages: number;
  tailLength: number;
  roleSequence: Message["role"][];
  endsWithUser: boolean;
  consecutiveSameRoleTransitions: number;
  pairingStats: {
    toolUseCount: number;
    toolResultCount: number;
    toolUsesWithoutResult: number;
    toolResultsWithoutUse: number;
    syntheticToolResultCount: number;
    assistantMessagesWithToolResults: number;
    orphanToolResultTextCount: number;
  };
  tail: HistoryTailMessageSummary[];
}

export interface RepairResult {
  messages: Message[];
  stats: RepairStats;
  diagnostics: HistoryRepairDiagnostics;
}

const SYNTHETIC_RESULT =
  "<synthesized_result>tool result missing from history</synthesized_result>";

const SYNTHETIC_WEB_SEARCH_ERROR = {
  type: "web_search_tool_result_error",
  error_code: "unavailable",
};

const historyRepairDiagnosticsByMessages = new WeakMap<
  Message[],
  HistoryRepairDiagnostics
>();

function cloneRepairStats(stats: RepairStats): RepairStats {
  return {
    assistantToolResultsMigrated: stats.assistantToolResultsMigrated,
    missingToolResultsInserted: stats.missingToolResultsInserted,
    orphanToolResultsDowngraded: stats.orphanToolResultsDowngraded,
    consecutiveSameRoleMerged: stats.consecutiveSameRoleMerged,
  };
}

function buildHistoryRepairDiagnostics(
  stats: RepairStats,
): HistoryRepairDiagnostics {
  const clonedStats = cloneRepairStats(stats);
  return {
    stats: clonedStats,
    actions: {
      migratedAssistantToolResults: clonedStats.assistantToolResultsMigrated > 0,
      insertedSyntheticToolResults: clonedStats.missingToolResultsInserted > 0,
      repairedOrphanToolResults: clonedStats.orphanToolResultsDowngraded > 0,
      mergedSameRoleMessages: clonedStats.consecutiveSameRoleMerged > 0,
    },
  };
}

function rememberHistoryRepairDiagnostics(
  messages: Message[],
  diagnostics: HistoryRepairDiagnostics,
): void {
  historyRepairDiagnosticsByMessages.set(messages, diagnostics);
}

export function getHistoryRepairDiagnostics(
  messages: ReadonlyArray<Message>,
): HistoryRepairDiagnostics | null {
  const diagnostics = historyRepairDiagnosticsByMessages.get(
    messages as Message[],
  );
  if (!diagnostics) return null;
  return {
    stats: cloneRepairStats(diagnostics.stats),
    actions: { ...diagnostics.actions },
  };
}

function isSyntheticToolResultBlock(block: ToolResultContent): boolean {
  return (
    typeof block.content === "string" &&
    block.content === SYNTHETIC_RESULT &&
    block.is_error === true
  );
}

function isToolResultBlock(block: ContentBlock): block is ToolResultContent {
  return block.type === "tool_result";
}

function isSyntheticWebSearchToolResultBlock(block: ContentBlock): boolean {
  return (
    block.type === "web_search_tool_result" &&
    block.content != null &&
    typeof block.content === "object" &&
    (block.content as { type?: unknown }).type ===
      SYNTHETIC_WEB_SEARCH_ERROR.type &&
    (block.content as { error_code?: unknown }).error_code ===
      SYNTHETIC_WEB_SEARCH_ERROR.error_code
  );
}

function isOrphanToolResultDowngradeText(text: string): boolean {
  return text.startsWith("[orphaned tool_result for ");
}

export function describeHistoryTail(
  messages: ReadonlyArray<Message>,
  tailLength = 6,
): HistoryTailSnapshot {
  const normalizedTailLength = Math.max(tailLength, 0);
  const tailMessages =
    normalizedTailLength === 0
      ? []
      : messages.slice(-normalizedTailLength);
  const roleSequence = tailMessages.map((message) => message.role);

  let consecutiveSameRoleTransitions = 0;
  for (let i = 1; i < roleSequence.length; i++) {
    if (roleSequence[i] === roleSequence[i - 1]) {
      consecutiveSameRoleTransitions++;
    }
  }

  const pendingToolUseIds = new Set<string>();
  const pendingServerToolUseIds = new Set<string>();
  let toolUseCount = 0;
  let toolResultCount = 0;
  let toolResultsWithoutUse = 0;
  let syntheticToolResultCount = 0;
  let assistantMessagesWithToolResults = 0;
  let orphanToolResultTextCount = 0;

  const tail = tailMessages.map((message): HistoryTailMessageSummary => {
    const summary: HistoryTailMessageSummary = {
      role: message.role,
      blockTypes: [],
      textBlockCount: 0,
      toolUseCount: 0,
      toolResultCount: 0,
      syntheticToolResultCount: 0,
      orphanToolResultTextCount: 0,
      serverToolUseCount: 0,
      webSearchToolResultCount: 0,
    };
    let sawAssistantToolResult = false;

    for (const block of message.content) {
      summary.blockTypes.push(block.type);
      if (block.type === "text") {
        summary.textBlockCount++;
        if (isOrphanToolResultDowngradeText(block.text)) {
          summary.orphanToolResultTextCount++;
          orphanToolResultTextCount++;
        }
        continue;
      }
      if (block.type === "tool_use") {
        toolUseCount++;
        summary.toolUseCount++;
        pendingToolUseIds.add(block.id);
        continue;
      }
      if (
        block.type === "tool_result" ||
        block.type === "web_search_tool_result"
      ) {
        toolResultCount++;
        summary.toolResultCount++;
        if (message.role === "assistant") {
          sawAssistantToolResult = true;
        }
        if (isToolResultBlock(block)) {
          if (isSyntheticToolResultBlock(block)) {
            syntheticToolResultCount++;
            summary.syntheticToolResultCount++;
          }
          if (message.role === "assistant") {
            toolResultsWithoutUse++;
          } else if (!pendingToolUseIds.delete(block.tool_use_id)) {
            toolResultsWithoutUse++;
          }
        } else {
          summary.webSearchToolResultCount++;
          if (isSyntheticWebSearchToolResultBlock(block)) {
            syntheticToolResultCount++;
            summary.syntheticToolResultCount++;
          }
          if (!pendingServerToolUseIds.delete(block.tool_use_id)) {
            toolResultsWithoutUse++;
          }
        }
        continue;
      }
      if (block.type === "server_tool_use") {
        toolUseCount++;
        summary.serverToolUseCount++;
        pendingServerToolUseIds.add(block.id);
      }
    }

    if (sawAssistantToolResult) {
      assistantMessagesWithToolResults++;
    }

    return summary;
  });

  return {
    totalMessages: messages.length,
    tailLength: tail.length,
    roleSequence,
    endsWithUser: tailMessages.at(-1)?.role === "user",
    consecutiveSameRoleTransitions,
    pairingStats: {
      toolUseCount,
      toolResultCount,
      toolUsesWithoutResult:
        pendingToolUseIds.size + pendingServerToolUseIds.size,
      toolResultsWithoutUse,
      syntheticToolResultCount,
      assistantMessagesWithToolResults,
      orphanToolResultTextCount,
    },
    tail,
  };
}

export function repairHistory(messages: Message[]): RepairResult {
  const stats: RepairStats = {
    assistantToolResultsMigrated: 0,
    missingToolResultsInserted: 0,
    orphanToolResultsDowngraded: 0,
    consecutiveSameRoleMerged: 0,
  };

  // Merge same-role messages before tool pairing so a Slack tail like
  // assistant(tool_use) + assistant(text) keeps the trailing text attached
  // to the tool-calling assistant turn before synthetic tool_results are
  // inserted. We still run a second merge pass after repair because the
  // tool-result synthesis can introduce new adjacent user messages.
  const normalizedInput = mergeConsecutiveSameRoleMessages(messages, stats);
  const result: Message[] = [];
  let pendingToolUseIds = new Set<string>();
  // tool_result blocks stripped from assistant messages, keyed by tool_use_id
  let recoveredResults = new Map<string, ToolResultContent>();

  for (const msg of normalizedInput) {
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
  const merged = mergeConsecutiveSameRoleMessages(result, stats);

  const diagnostics = buildHistoryRepairDiagnostics(stats);
  rememberHistoryRepairDiagnostics(merged, diagnostics);
  return { messages: merged, stats, diagnostics };
}

function mergeConsecutiveSameRoleMessages(
  messages: ReadonlyArray<Message>,
  stats: RepairStats,
): Message[] {
  const merged: Message[] = [];
  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = [...prev.content, ...msg.content];
      stats.consecutiveSameRoleMerged++;
    } else {
      merged.push({ role: msg.role, content: [...msg.content] });
    }
  }
  return merged;
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
 * Aggressive repair pass that handles edge cases beyond repairHistory:
 * - Removes empty messages
 * - Ensures the first message is from the user
 * Then applies the standard repairHistory on top, which now pre-merges
 * consecutive same-role messages before tool-use/result repair and merges any
 * new adjacencies introduced by the repair itself.
 */
export function deepRepairHistory(messages: Message[]): RepairResult {
  // 1. Remove messages with no content blocks
  let cleaned = messages.filter((m) => m.content.length > 0);

  // 2. Strip leading assistant messages (provider requires user-first)
  while (cleaned.length > 0 && cleaned[0].role === "assistant") {
    cleaned = cleaned.slice(1);
  }

  // 3. Apply standard tool-use/tool-result repair on top
  return repairHistory(cleaned);
}
