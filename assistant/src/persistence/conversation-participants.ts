/**
 * Conversation membership for non-guardian principals.
 *
 * A conversation with no rows belongs to the guardian alone. Reads skip
 * rows stamped `removed_at`, so removal ends access without erasing who
 * took part.
 */

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { type DrizzleDb, getDb } from "./db-connection.js";
import { conversationParticipants } from "./schema/index.js";

export type ConversationParticipantRole = "creator" | "participant";

export interface ConversationParticipantStoreOptions {
  db?: DrizzleDb;
}

export interface AddParticipantInput {
  conversationId: string;
  principalId: string;
  role: ConversationParticipantRole;
  addedBy?: string | null;
  addedAt?: number;
}

export interface ConversationParticipant {
  conversationId: string;
  principalId: string;
  role: ConversationParticipantRole;
  addedBy: string | null;
  addedAt: number;
  removedAt: number | null;
}

function resolveDb(options?: ConversationParticipantStoreOptions): DrizzleDb {
  return options?.db ?? getDb();
}

function rowToParticipant(
  row: typeof conversationParticipants.$inferSelect,
): ConversationParticipant {
  return {
    conversationId: row.conversationId,
    principalId: row.principalId,
    role: row.role,
    addedBy: row.addedBy ?? null,
    addedAt: row.addedAt,
    removedAt: row.removedAt ?? null,
  };
}

/**
 * Add a principal to a conversation, or re-add one whose row was stamped
 * removed. Re-adding clears `removed_at` and takes the new role and
 * timestamps. A principal who is already a live participant keeps the
 * role and provenance they have; use a dedicated update to change those.
 */
export function addParticipant(
  input: AddParticipantInput,
  options?: ConversationParticipantStoreOptions,
): ConversationParticipant {
  const db = resolveDb(options);
  const addedAt = input.addedAt ?? Date.now();
  const addedBy = input.addedBy ?? null;

  const written = db
    .insert(conversationParticipants)
    .values({
      conversationId: input.conversationId,
      principalId: input.principalId,
      role: input.role,
      addedBy,
      addedAt,
      removedAt: null,
    })
    .onConflictDoUpdate({
      target: [
        conversationParticipants.conversationId,
        conversationParticipants.principalId,
      ],
      set: { role: input.role, addedBy, addedAt, removedAt: null },
      setWhere: isNotNull(conversationParticipants.removedAt),
    })
    .returning()
    .get();

  if (written) {
    return rowToParticipant(written);
  }

  const existing = db
    .select()
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, input.conversationId),
        eq(conversationParticipants.principalId, input.principalId),
      ),
    )
    .get();

  if (!existing) {
    throw new Error(
      `conversation_participants row vanished for ${input.conversationId}/${input.principalId}`,
    );
  }

  return rowToParticipant(existing);
}

/** Stamp a participant removed. Returns false when no live row matched. */
export function removeParticipant(
  conversationId: string,
  principalId: string,
  options?: ConversationParticipantStoreOptions & { removedAt?: number },
): boolean {
  const db = resolveDb(options);
  const rows = db
    .update(conversationParticipants)
    .set({ removedAt: options?.removedAt ?? Date.now() })
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.principalId, principalId),
        isNull(conversationParticipants.removedAt),
      ),
    )
    .returning()
    .all();

  return rows.length > 0;
}

export function isParticipant(
  conversationId: string,
  principalId: string,
  options?: ConversationParticipantStoreOptions,
): boolean {
  const db = resolveDb(options);
  const row = db
    .select({ principalId: conversationParticipants.principalId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.principalId, principalId),
        isNull(conversationParticipants.removedAt),
      ),
    )
    .get();

  return row !== undefined;
}

export function listConversationIdsForPrincipal(
  principalId: string,
  options?: ConversationParticipantStoreOptions,
): string[] {
  const db = resolveDb(options);
  return db
    .select({ conversationId: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.principalId, principalId),
        isNull(conversationParticipants.removedAt),
      ),
    )
    .all()
    .map((row) => row.conversationId);
}
