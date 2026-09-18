import { and, asc, eq, inArray, sql } from "drizzle-orm";

import {
  type ModeSessionMode,
  modeSessionRowStartsDisplay,
  type ModeSessionStatus,
  type ModeSessionSummary,
  ModeSessionSummarySchema,
} from "../api/mode-session.js";
import { type DrizzleDb, getDb } from "./db-connection.js";
import {
  readMessageSentAt,
  readModeSessionMetadata,
} from "./message-metadata.js";
import { conversationModeSessions, messages } from "./schema/index.js";

export type ModeSessionWriteFailureReason =
  | "already_exists"
  | "not_found"
  | "stale_revision"
  | "terminal";

export type ModeSessionWriteResult =
  | { ok: true; session: ModeSessionSummary }
  | {
      ok: false;
      reason: ModeSessionWriteFailureReason;
      session?: ModeSessionSummary;
    };

export interface ModeSessionStoreOptions {
  db?: DrizzleDb;
}

type ModeSessionReader = Pick<DrizzleDb, "select">;

interface ModeSessionMutationOptions extends ModeSessionStoreOptions {
  acceptTerminal?: (
    current: typeof conversationModeSessions.$inferSelect,
  ) => boolean;
}

export interface BeginModeSessionInput {
  id: string;
  conversationId: string;
  mode: ModeSessionMode;
  sourceStartedAt: number;
}

export interface RevisionedModeSessionInput {
  id: string;
  conversationId: string;
  expectedRevision: number;
}

export interface UpdateModeSessionActivityInput extends RevisionedModeSessionInput {
  lastActivityAt: number;
  lastOwnedMessageId?: string | null;
}

export interface UpdateModeSessionBoundariesInput extends RevisionedModeSessionInput {
  firstIncluded: { at: number; messageId: string } | null;
  lastActivityAt: number;
  lastOwnedMessageId: string | null;
}

interface FinalizeModeSessionInputBase extends RevisionedModeSessionInput {
  endReason: string;
  lastActivityAt?: number;
  lastOwnedMessageId?: string | null;
}

export type FinalizeModeSessionInput = FinalizeModeSessionInputBase &
  (
    | { status: Extract<ModeSessionStatus, "completed">; endedAt: number }
    | {
        status: Extract<ModeSessionStatus, "interrupted">;
        endedAt: number | null;
      }
  );

function toSummary(
  row: typeof conversationModeSessions.$inferSelect,
): ModeSessionSummary {
  return ModeSessionSummarySchema.parse(row);
}

function getSession(
  database: ModeSessionReader,
  conversationId: string,
  id: string,
): typeof conversationModeSessions.$inferSelect | undefined {
  return database
    .select()
    .from(conversationModeSessions)
    .where(
      and(
        eq(conversationModeSessions.conversationId, conversationId),
        eq(conversationModeSessions.id, id),
      ),
    )
    .get();
}

function classifyRejectedWrite(
  current: typeof conversationModeSessions.$inferSelect | undefined,
  expectedRevision: number,
): ModeSessionWriteResult {
  if (!current) {
    return { ok: false, reason: "not_found" };
  }
  const session = toSummary(current);
  if (current.status !== "active") {
    return { ok: false, reason: "terminal", session };
  }
  if (current.revision !== expectedRevision) {
    return { ok: false, reason: "stale_revision", session };
  }
  throw new Error("Mode session write was rejected without a state conflict");
}

function mutateActiveSession(
  input: RevisionedModeSessionInput,
  buildValues: (
    current: typeof conversationModeSessions.$inferSelect,
  ) => Partial<typeof conversationModeSessions.$inferInsert>,
  options?: ModeSessionMutationOptions,
): ModeSessionWriteResult {
  const database = options?.db ?? getDb();
  return database.transaction(
    (tx) => {
      const current = getSession(tx, input.conversationId, input.id);
      if (
        !current ||
        current.status !== "active" ||
        current.revision !== input.expectedRevision
      ) {
        if (
          current &&
          current.status !== "active" &&
          options?.acceptTerminal?.(current)
        ) {
          return { ok: true, session: toSummary(current) };
        }
        return classifyRejectedWrite(current, input.expectedRevision);
      }

      tx.update(conversationModeSessions)
        .set({
          ...buildValues(current),
          revision: sql`${conversationModeSessions.revision} + 1`,
        })
        .where(
          and(
            eq(conversationModeSessions.conversationId, input.conversationId),
            eq(conversationModeSessions.id, input.id),
            eq(conversationModeSessions.status, "active"),
            eq(conversationModeSessions.revision, input.expectedRevision),
          ),
        )
        .run();

      const updated = getSession(tx, input.conversationId, input.id);
      if (!updated || updated.revision !== input.expectedRevision + 1) {
        return classifyRejectedWrite(updated, input.expectedRevision);
      }
      return { ok: true, session: toSummary(updated) };
    },
    { behavior: "immediate" },
  );
}

export function beginConversationModeSession(
  input: BeginModeSessionInput,
  options?: ModeSessionStoreOptions,
): ModeSessionWriteResult {
  const database = options?.db ?? getDb();
  return database.transaction(
    (tx) => {
      const existing = tx
        .select()
        .from(conversationModeSessions)
        .where(eq(conversationModeSessions.id, input.id))
        .get();
      if (existing) {
        return {
          ok: false,
          reason: "already_exists",
          ...(existing.conversationId === input.conversationId
            ? { session: toSummary(existing) }
            : {}),
        };
      }

      tx.insert(conversationModeSessions)
        .values({
          ...input,
          status: "active",
          firstIncludedAt: null,
          firstIncludedMessageId: null,
          lastActivityAt: input.sourceStartedAt,
          lastOwnedMessageId: null,
          endedAt: null,
          endReason: null,
          revision: 1,
        })
        .run();
      const created = getSession(tx, input.conversationId, input.id);
      if (!created) {
        throw new Error("Mode session insert did not create a readable row");
      }
      return { ok: true, session: toSummary(created) };
    },
    { behavior: "immediate" },
  );
}

export function updateConversationModeSessionActivity(
  input: UpdateModeSessionActivityInput,
  options?: ModeSessionStoreOptions,
): ModeSessionWriteResult {
  return mutateActiveSession(
    input,
    (current) => ({
      lastActivityAt: Math.max(current.lastActivityAt, input.lastActivityAt),
      ...(input.lastOwnedMessageId !== undefined
        ? { lastOwnedMessageId: input.lastOwnedMessageId }
        : {}),
    }),
    options,
  );
}

export function updateConversationModeSessionBoundaries(
  input: UpdateModeSessionBoundariesInput,
  options?: ModeSessionStoreOptions,
): ModeSessionWriteResult {
  return mutateActiveSession(
    input,
    (current) => ({
      firstIncludedAt: input.firstIncluded?.at ?? null,
      firstIncludedMessageId: input.firstIncluded?.messageId ?? null,
      lastActivityAt: Math.max(current.lastActivityAt, input.lastActivityAt),
      lastOwnedMessageId: input.lastOwnedMessageId,
    }),
    options,
  );
}

export function advanceConversationModeSessionRevision(
  input: RevisionedModeSessionInput,
  options?: ModeSessionStoreOptions,
): ModeSessionWriteResult {
  return mutateActiveSession(input, () => ({}), options);
}

export function finalizeConversationModeSession(
  input: FinalizeModeSessionInput,
  options?: ModeSessionStoreOptions,
): ModeSessionWriteResult {
  return mutateActiveSession(
    input,
    (current) => {
      const lastActivityAt = Math.max(
        current.lastActivityAt,
        input.lastActivityAt ?? current.lastActivityAt,
      );
      if (input.endedAt !== null && input.endedAt < lastActivityAt) {
        throw new Error("Mode session end cannot precede its last activity");
      }
      return {
        status: input.status,
        endedAt: input.endedAt,
        endReason: input.endReason,
        lastActivityAt,
        ...(input.lastOwnedMessageId !== undefined
          ? { lastOwnedMessageId: input.lastOwnedMessageId }
          : {}),
      };
    },
    {
      ...options,
      acceptTerminal: (current) =>
        current.status === input.status &&
        current.endedAt === input.endedAt &&
        current.endReason === input.endReason &&
        (input.lastActivityAt === undefined ||
          input.lastActivityAt <= current.lastActivityAt) &&
        (input.lastOwnedMessageId === undefined ||
          input.lastOwnedMessageId === current.lastOwnedMessageId),
    },
  );
}

export function getConversationModeSession(
  conversationId: string,
  id: string,
  options?: ModeSessionStoreOptions,
): ModeSessionSummary | null {
  const row = getSession(options?.db ?? getDb(), conversationId, id);
  return row ? toSummary(row) : null;
}

export function listConversationModeSessionsByIds(
  conversationId: string,
  ids: readonly string[],
  options?: ModeSessionStoreOptions,
): ModeSessionSummary[] {
  if (ids.length === 0) {
    return [];
  }
  const rows = (options?.db ?? getDb())
    .select()
    .from(conversationModeSessions)
    .where(
      and(
        eq(conversationModeSessions.conversationId, conversationId),
        inArray(conversationModeSessions.id, [...new Set(ids)]),
      ),
    )
    .all();
  return rows.map(toSummary);
}

export function recoverActiveConversationModeSessions(
  options?: ModeSessionStoreOptions,
): number {
  const result = (options?.db ?? getDb())
    .update(conversationModeSessions)
    .set({
      status: "interrupted",
      endedAt: null,
      endReason: "assistant_restarted",
      revision: sql`${conversationModeSessions.revision} + 1`,
    })
    .where(eq(conversationModeSessions.status, "active"))
    .run() as unknown as { changes: number };
  return result.changes;
}

/** Recompute replaceable row boundaries after destructive transcript edits. */
export function repairConversationModeSessionBoundaries(
  conversationId: string,
  options?: ModeSessionStoreOptions,
): number {
  const database = options?.db ?? getDb();
  return database.transaction(
    (tx) => {
      const sessions = tx
        .select()
        .from(conversationModeSessions)
        .where(eq(conversationModeSessions.conversationId, conversationId))
        .all();
      if (sessions.length === 0) {
        return 0;
      }
      const sessionsById = new Map(
        sessions.map((session) => [session.id, session]),
      );
      const boundaries = new Map<
        string,
        {
          firstAt: number | null;
          firstMessageId: string | null;
          lastAt: number;
          lastMessageId: string;
        }
      >();
      for (const message of tx
        .select({
          id: messages.id,
          role: messages.role,
          createdAt: messages.createdAt,
          metadata: messages.metadata,
        })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .all()) {
        const owner = readModeSessionMetadata(message.metadata);
        if (!owner) {
          continue;
        }
        const session = sessionsById.get(owner.id);
        if (!session || session.mode !== owner.mode) {
          continue;
        }
        const at = readMessageSentAt(message.metadata) ?? message.createdAt;
        const startsDisplayBoundary = modeSessionRowStartsDisplay(
          session.mode,
          message.role === "assistant",
        );
        const current = boundaries.get(owner.id);
        if (!current) {
          boundaries.set(owner.id, {
            firstAt: startsDisplayBoundary ? at : null,
            firstMessageId: startsDisplayBoundary ? message.id : null,
            lastAt: at,
            lastMessageId: message.id,
          });
        } else {
          if (
            startsDisplayBoundary &&
            (current.firstAt === null || at < current.firstAt)
          ) {
            current.firstAt = at;
            current.firstMessageId = message.id;
          }
          current.lastAt = Math.max(current.lastAt, at);
          current.lastMessageId = message.id;
        }
      }

      let repaired = 0;
      for (const session of sessions) {
        const boundary = boundaries.get(session.id);
        const firstIncludedAt = boundary?.firstAt ?? null;
        const firstIncludedMessageId = boundary?.firstMessageId ?? null;
        const lastOwnedMessageId = boundary?.lastMessageId ?? null;
        const observedLastActivityAt =
          boundary?.lastAt ?? session.lastActivityAt;
        const lastActivityAt =
          session.endedAt === null
            ? Math.max(session.lastActivityAt, observedLastActivityAt)
            : Math.min(
                session.endedAt,
                Math.max(session.lastActivityAt, observedLastActivityAt),
              );
        if (
          session.firstIncludedAt === firstIncludedAt &&
          session.firstIncludedMessageId === firstIncludedMessageId &&
          session.lastOwnedMessageId === lastOwnedMessageId &&
          session.lastActivityAt === lastActivityAt
        ) {
          continue;
        }
        const result = tx
          .update(conversationModeSessions)
          .set({
            firstIncludedAt,
            firstIncludedMessageId,
            lastOwnedMessageId,
            lastActivityAt,
            revision: sql`${conversationModeSessions.revision} + 1`,
          })
          .where(
            and(
              eq(conversationModeSessions.conversationId, conversationId),
              eq(conversationModeSessions.id, session.id),
              eq(conversationModeSessions.revision, session.revision),
            ),
          )
          .run() as unknown as { changes: number };
        repaired += result.changes;
      }
      return repaired;
    },
    { behavior: "immediate" },
  );
}
