/**
 * Compile all active playbook memory items into a triage context block
 * that can be injected into the system prompt alongside the contact
 * graph.
 */

import { and, desc, eq, isNull } from "drizzle-orm";

import { getDb } from "../memory/db.js";
import { memoryItems } from "../memory/schema.js";
import type { Playbook } from "./types.js";
import { parsePlaybookStatement } from "./types.js";

export interface CompiledPlaybooks {
  /** Formatted text block ready for system prompt injection. */
  text: string;
  /** Total number of active playbook items found. */
  totalCount: number;
  /** Number of playbooks successfully parsed and included. */
  includedCount: number;
}

export interface CompilePlaybooksOptions {
  scopeId?: string;
}

interface PlaybookRow {
  id: string;
  subject: string;
  statement: string;
}

export function compilePlaybooks(
  options?: CompilePlaybooksOptions,
): CompiledPlaybooks {
  const scopeId = options?.scopeId ?? "default";
  const db = getDb();

  const rows: PlaybookRow[] = db
    .select({
      id: memoryItems.id,
      subject: memoryItems.subject,
      statement: memoryItems.statement,
    })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.kind, "playbook"),
        eq(memoryItems.status, "active"),
        eq(memoryItems.scopeId, scopeId),
        isNull(memoryItems.invalidAt),
      ),
    )
    .orderBy(desc(memoryItems.importance))
    .all();

  if (rows.length === 0) {
    return { text: "", totalCount: 0, includedCount: 0 };
  }

  const parsed: Array<{ id: string; subject: string; playbook: Playbook }> = [];
  for (const row of rows) {
    const playbook = parsePlaybookStatement(row.statement);
    if (playbook) {
      parsed.push({ id: row.id, subject: row.subject, playbook });
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
