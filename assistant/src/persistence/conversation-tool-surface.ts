import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import type { ToolDefinition } from "../providers/types.js";
import { getDb } from "./db-connection.js";
import { conversationToolSurfaces } from "./schema/index.js";

/**
 * Per-conversation record of the tool definitions the most recent live turn
 * sent to the provider (`conversation_tool_surfaces`).
 *
 * The provider prompt cache is a byte-exact prefix match over
 * `tools -> system -> messages`, so a background wake that forks a
 * conversation can only reuse the source's cached prefix by sending the SAME
 * tools array. Re-deriving the array on the fork cannot guarantee that: the
 * fork may run in another process (a different tool registry), with no
 * connected clients (different host-tool gates), or under a presence the
 * persisted message stamps do not encode. Recording the resolved array and
 * replaying it verbatim can.
 */

/** Content hash of the serialized tools array. */
export function hashConversationToolSurface(
  tools: readonly ToolDefinition[],
): string {
  return hashToolsJson(JSON.stringify(tools));
}

function hashToolsJson(toolsJson: string): string {
  return createHash("sha256").update(toolsJson).digest("hex").slice(0, 32);
}

/**
 * Persist `tools` as the conversation's current wire tool surface and return
 * its hash. `knownHash` is the hash the caller last recorded for this
 * conversation (undefined when it has recorded nothing this process
 * lifetime): a matching hash skips the statement outright. Otherwise the
 * upsert only rewrites a row whose stored hash differs, so a conversation
 * reloaded from disk never rewrites an unchanged surface either.
 */
export function recordConversationToolSurface(
  conversationId: string,
  tools: readonly ToolDefinition[],
  knownHash?: string,
): string {
  const toolsJson = JSON.stringify(tools);
  const toolsHash = hashToolsJson(toolsJson);
  if (knownHash === toolsHash) {
    return toolsHash;
  }
  const updatedAt = Date.now();
  getDb()
    .insert(conversationToolSurfaces)
    .values({ conversationId, toolsJson, toolsHash, updatedAt })
    .onConflictDoUpdate({
      target: conversationToolSurfaces.conversationId,
      set: { toolsJson, toolsHash, updatedAt },
      setWhere: sql`${conversationToolSurfaces.toolsHash} <> excluded.tools_hash`,
    })
    .run();
  return toolsHash;
}

/**
 * The tool definitions the conversation's most recent live turn sent, or
 * `null` when no turn has recorded one (or the stored JSON is unreadable).
 */
export function getConversationToolSurface(
  conversationId: string,
): ToolDefinition[] | null {
  const row = getDb()
    .select({ toolsJson: conversationToolSurfaces.toolsJson })
    .from(conversationToolSurfaces)
    .where(eq(conversationToolSurfaces.conversationId, conversationId))
    .get();
  if (!row) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(row.toolsJson);
    return Array.isArray(parsed) ? (parsed as ToolDefinition[]) : null;
  } catch {
    return null;
  }
}
