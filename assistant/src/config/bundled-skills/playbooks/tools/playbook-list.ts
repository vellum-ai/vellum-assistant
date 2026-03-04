import { and, desc, eq, isNull } from "drizzle-orm";

import { getDb } from "../../../../memory/db.js";
import { memoryItems } from "../../../../memory/schema.js";
import { parsePlaybookStatement } from "../../../../playbooks/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function executePlaybookList(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const scopeId = context.memoryScopeId ?? "default";
  const channelFilter =
    typeof input.channel === "string" ? input.channel : null;
  const categoryFilter =
    typeof input.category === "string" ? input.category : null;

  try {
    const db = getDb();

    const rows = db
      .select({
        id: memoryItems.id,
        subject: memoryItems.subject,
        statement: memoryItems.statement,
        importance: memoryItems.importance,
        lastSeenAt: memoryItems.lastSeenAt,
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
      return { content: "No playbooks found.", isError: false };
    }

    const entries: Array<{
      id: string;
      subject: string;
      statement: string;
      playbook: NonNullable<ReturnType<typeof parsePlaybookStatement>>;
    }> = [];
    for (const row of rows) {
      const playbook = parsePlaybookStatement(row.statement);
      if (!playbook) continue;

      // Apply filters
      if (
        channelFilter &&
        playbook.channel !== channelFilter &&
        playbook.channel !== "*"
      )
        continue;
      if (categoryFilter && playbook.category !== categoryFilter) continue;

      entries.push({
        id: row.id,
        subject: row.subject,
        statement: row.statement,
        playbook,
      });
    }

    if (entries.length === 0) {
      const filters = [
        channelFilter ? `channel="${channelFilter}"` : null,
        categoryFilter ? `category="${categoryFilter}"` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return {
        content: `No playbooks found matching ${filters}.`,
        isError: false,
      };
    }

    // Sort by priority descending
    entries.sort((a, b) => b.playbook.priority - a.playbook.priority);

    const lines: string[] = [`Found ${entries.length} playbook(s):\n`];
    for (const { id, playbook } of entries) {
      const channelLabel =
        playbook.channel === "*" ? "all channels" : playbook.channel;
      const autonomyLabel =
        playbook.autonomyLevel === "auto"
          ? "auto"
          : playbook.autonomyLevel === "draft"
            ? "draft"
            : "notify";
      lines.push(
        `- **${playbook.trigger}** (${channelLabel}) → ${playbook.action}`,
      );
      lines.push(
        `  _ID: ${id} | category: ${playbook.category} | autonomy: ${autonomyLabel} | priority: ${playbook.priority}_`,
      );
    }

    return { content: lines.join("\n"), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error listing playbooks: ${msg}`, isError: true };
  }
}

export { executePlaybookList as run };
