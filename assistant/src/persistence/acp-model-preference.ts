/**
 * The per-conversation ACP model preference.
 *
 * Answers, before a run starts, which model this conversation's next run on a
 * given agent should be put on. Written only when the user chooses one, so it
 * never inherits a fallback the user never asked for; `acp_session_history` is
 * the record of what a finished run actually used.
 *
 * Nothing here deletes: the row cascades from its conversation, so a
 * conversation delete takes its preferences with it.
 */

import { and, eq } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import { acpConversationModelPreference } from "./schema/index.js";

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
