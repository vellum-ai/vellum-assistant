import { repairHistory } from "../plugins/defaults/history-repair/terminal.js";
import type { Message } from "../providers/types.js";

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
