/**
 * Compile all active playbook graph nodes into a triage context block
 * that can be injected into the system prompt alongside the contact
 * graph.
 */

import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../memory/db.js";
import { memoryGraphNodes } from "../memory/schema.js";
import type { Playbook } from "./types.js";
import { parsePlaybookStatement } from "./types.js";

export interface CompiledPlaybooks {
  /** Formatted text block ready for system prompt injection. */
  text: string;
  /** Total number of active playbook nodes found. */
  totalCount: number;
  /** Number of playbooks successfully parsed and included. */
  includedCount: number;
}

export interface CompilePlaybooksOptions {
  scopeId?: string;
}

interface PlaybookRow {
  id: string;
  content: string;
}

export function compilePlaybooks(
  options?: CompilePlaybooksOptions,
): CompiledPlaybooks {
  const scopeId = options?.scopeId ?? "default";
  const db = getDb();

  const rows: PlaybookRow[] = db
    .select({
      id: memoryGraphNodes.id,
      content: memoryGraphNodes.content,
    })
    .from(memoryGraphNodes)
    .where(
      and(
        eq(memoryGraphNodes.scopeId, scopeId),
        sql`${memoryGraphNodes.sourceConversations} LIKE '%playbook:%'`,
        sql`${memoryGraphNodes.fidelity} != 'gone'`,
      ),
    )
    .orderBy(sql`${memoryGraphNodes.significance} DESC`)
    .all();

  if (rows.length === 0) {
    return { text: "", totalCount: 0, includedCount: 0 };
  }

  const parsed: Array<{ id: string; playbook: Playbook }> = [];
  for (const row of rows) {
    // Content format: "Playbook: <trigger>\n<json statement>"
    const newlineIdx = row.content.indexOf("\n");
    if (newlineIdx === -1) continue;
    const statement = row.content.slice(newlineIdx + 1);
    const playbook = parsePlaybookStatement(statement);
    if (playbook) {
      parsed.push({ id: row.id, playbook });
    }
  }

  if (parsed.length === 0) {
    return { text: "", totalCount: rows.length, includedCount: 0 };
  }

  // Sort by priority descending so higher-priority rules appear first
  parsed.sort((a, b) => b.playbook.priority - a.playbook.priority);

  const lines: string[] = ["<action-playbooks>"];
  for (const { playbook } of parsed) {
    const channelLabel =
      playbook.channel === "*" ? "all channels" : playbook.channel;
    const autonomyLabel =
      playbook.autonomyLevel === "auto"
        ? "execute automatically"
        : playbook.autonomyLevel === "draft"
          ? "draft for review"
          : "notify only";
    lines.push(
      `- WHEN "${playbook.trigger}" on ${channelLabel} → ${playbook.action} [${autonomyLabel}, priority=${playbook.priority}]`,
    );
  }
  lines.push("</action-playbooks>");

  return {
    text: lines.join("\n"),
    totalCount: rows.length,
    includedCount: parsed.length,
  };
}
