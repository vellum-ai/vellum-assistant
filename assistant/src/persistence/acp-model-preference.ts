/**
 * The per-conversation ACP model preference.
 *
 * Answers, before a run starts, which model this conversation's next run on a
 * given agent should be put on. Written only when the user chooses one, so it
 * never inherits a fallback the user never asked for; `acp_session_history` is
 * the record of what a finished run actually used.
 */

import { and, eq } from "drizzle-orm";

import { type DrizzleDb, getDb } from "./db-connection.js";
import { acpConversationModelPreference } from "./schema/index.js";

/**
 * Enough of a database handle to delete rows.
 *
 * Named as a slice so the delete can be handed the open transaction of a
 * conversation delete, and the preference rows commit or roll back with the
 * conversation row they belong to.
 */
type ModelPreferenceWriter = Pick<DrizzleDb, "delete">;

/** The model this conversation prefers for this agent, if it has chosen one. */
export function getAcpConversationModelPreference(
  parentConversationId: string,
  agentId: string,
): string | undefined {
  const row = getDb()
    .select({ model: acpConversationModelPreference.model })
    .from(acpConversationModelPreference)
    .where(
      and(
        eq(
          acpConversationModelPreference.parentConversationId,
          parentConversationId,
        ),
        eq(acpConversationModelPreference.agentId, agentId),
      ),
    )
    .get();
  return row?.model;
}

/** Record an explicit choice, replacing whatever this pair preferred before. */
export function upsertAcpConversationModelPreference(preference: {
  parentConversationId: string;
  agentId: string;
  model: string;
}): void {
  const updatedAt = Date.now();
  getDb()
    .insert(acpConversationModelPreference)
    .values({ ...preference, updatedAt })
    .onConflictDoUpdate({
      target: [
        acpConversationModelPreference.parentConversationId,
        acpConversationModelPreference.agentId,
      ],
      set: { model: preference.model, updatedAt },
    })
    .run();
}

/** Drop every agent's preference for a conversation that is going away. */
export function deleteAcpConversationModelPreferences(
  parentConversationId: string,
  db: ModelPreferenceWriter = getDb(),
): void {
  db.delete(acpConversationModelPreference)
    .where(
      eq(
        acpConversationModelPreference.parentConversationId,
        parentConversationId,
      ),
    )
    .run();
}
