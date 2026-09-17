import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import type { ToolDefinition } from "../providers/types.js";
import { getDb } from "./db-connection.js";
import { conversationToolSurfaces } from "./schema/index.js";

/**
 * Per-conversation record of what the most recent live turn sent to the
 * provider that a fork wake cannot re-derive (`conversation_tool_surfaces`).
 *
 * The provider prompt cache is a byte-exact prefix match over
 * `tools -> system -> messages`, so a background wake that forks a
 * conversation can only reuse the source's cached prefix by sending the SAME
 * tools array under the SAME system prompt. Re-deriving either on the fork
 * cannot guarantee that: the fork may run in another process (a different
 * tool registry), with no connected clients (different host-tool gates),
 * under a presence the persisted message stamps do not encode, or under a
 * wake scope that cannot spawn subagents where the source could (the system
 * prompt's delegation section). Recording the resolved values and replaying
 * them verbatim can.
 */

/** What a live turn sent that a replaying fork reproduces verbatim. */
export interface ConversationToolSurface {
  /** The tool definitions the turn sent, exactly as resolved. */
  tools: ToolDefinition[];
  /**
   * Whether the turn's system prompt rendered the parallel-delegation
   * section (`01-parallel-tasks`), which the prompt derives from the same
   * resolved tool surface plus the turn's channel. `null` when unknown: the
   * turn ran on a system-prompt override, or the row predates the column.
   */
  delegateIndependentTasks: boolean | null;
}

/** Content hash of the serialized surface. */
export function hashConversationToolSurface(
  surface: ConversationToolSurface,
): string {
  return hashSurface(
    JSON.stringify(surface.tools),
    surface.delegateIndependentTasks,
  );
}

function hashSurface(
  toolsJson: string,
  delegateIndependentTasks: boolean | null,
): string {
  const marker =
    delegateIndependentTasks === null
      ? ""
      : delegateIndependentTasks
        ? "1"
        : "0";
  return createHash("sha256")
    .update(toolsJson)
    .update("\n")
    .update(marker)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Persist `surface` as the conversation's current wire surface and return
 * its hash. `knownHash` is the hash the caller last recorded for this
 * conversation (undefined when it has recorded nothing this process
 * lifetime): a matching hash skips the statement outright. Otherwise the
 * upsert only rewrites a row whose stored hash differs, so a conversation
 * reloaded from disk never rewrites an unchanged surface either.
 */
export function recordConversationToolSurface(
  conversationId: string,
  surface: ConversationToolSurface,
  knownHash?: string,
): string {
  const toolsJson = JSON.stringify(surface.tools);
  const { delegateIndependentTasks } = surface;
  const toolsHash = hashSurface(toolsJson, delegateIndependentTasks);
  if (knownHash === toolsHash) {
    return toolsHash;
  }
  const updatedAt = Date.now();
  getDb()
    .insert(conversationToolSurfaces)
    .values({
      conversationId,
      toolsJson,
      toolsHash,
      delegateIndependentTasks,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: conversationToolSurfaces.conversationId,
      set: { toolsJson, toolsHash, delegateIndependentTasks, updatedAt },
      setWhere: sql`${conversationToolSurfaces.toolsHash} <> excluded.tools_hash`,
    })
    .run();
  return toolsHash;
}

/**
 * The surface the conversation's most recent live turn sent, or `null` when
 * no turn has recorded one (or the stored JSON is unreadable).
 */
export function getConversationToolSurface(
  conversationId: string,
): ConversationToolSurface | null {
  const row = getDb()
    .select({
      toolsJson: conversationToolSurfaces.toolsJson,
      delegateIndependentTasks:
        conversationToolSurfaces.delegateIndependentTasks,
    })
    .from(conversationToolSurfaces)
    .where(eq(conversationToolSurfaces.conversationId, conversationId))
    .get();
  if (!row) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(row.toolsJson);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return {
      tools: parsed as ToolDefinition[],
      delegateIndependentTasks: row.delegateIndependentTasks ?? null,
    };
  } catch {
    return null;
  }
}
