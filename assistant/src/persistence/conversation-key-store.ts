/**
 * Maps conversation keys to internal conversation IDs.
 *
 * The web UI identifies conversations by an opaque `conversationKey` (e.g.
 * a user ID, a channel chat ID).  This store resolves those keys to the
 * daemon's internal conversation IDs, creating new conversations on
 * first contact.
 */

import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { ChannelId } from "../channels/types.js";
import { cleanupBootstrapFiles } from "../prompts/bootstrap-cleanup.js";
import { getCurrentSeq } from "../runtime/assistant-stream-state.js";
import { getLogger } from "../util/logger.js";
import { initConversationDir } from "./conversation-disk-view.js";
import { GENERATING_TITLE } from "./conversation-title-service.js";
import type { NonScheduledConversationType } from "./conversation-types.js";
import { getDb } from "./db-connection.js";
import { conversationKeys, conversations } from "./schema/index.js";

const log = getLogger("conversation-key-store");

/**
 * Set after the first *standard* conversation is created so BOOTSTRAP.md is
 * deleted on the second. Background creates never touch it.
 */
let firstConversationSeen = false;

/**
 * Test-only reset of the process-global first-conversation flag, so a test file
 * can replay the "fresh install" sequence more than once.
 */
export function _resetFirstConversationSeenForTesting(): void {
  firstConversationSeen = false;
}

export interface ConversationKeyMapping {
  id: string;
  conversationKey: string;
  conversationId: string;
  createdAt: number;
}

/**
 * Look up the conversation ID for a given conversationKey.
 * Returns `null` if no mapping exists yet.
 */
export function getConversationByKey(
  conversationKey: string,
): ConversationKeyMapping | null {
  const db = getDb();
  const result = db
    .select()
    .from(conversationKeys)
    .where(eq(conversationKeys.conversationKey, conversationKey))
    .get();
  return result ?? null;
}

/**
 * Delete the conversation-key mapping for a given conversationKey.
 *
 * This is a soft reset: the old conversation data remains in the database,
 * but it is no longer reachable via this key.  The next message with the
 * same key will create a fresh conversation.
 *
 */
export function deleteConversationKey(conversationKey: string): void {
  const db = getDb();
  db.delete(conversationKeys)
    .where(eq(conversationKeys.conversationKey, conversationKey))
    .run();
}

/**
 * Map a conversation key to an existing conversation ID (no creation).
 */
export function setConversationKey(
  conversationKey: string,
  conversationId: string,
): void {
  const db = getDb();
  db.insert(conversationKeys)
    .values({
      id: uuid(),
      conversationKey,
      conversationId,
      createdAt: Date.now(),
    })
    .run();
}

/**
 * Insert a conversation-key mapping only if the key does not already exist.
 *
 * Uses `onConflictDoNothing` on the unique `conversationKey` column to
 * avoid unique-constraint races when concurrent first messages attempt
 * to migrate a legacy key to a new scoped alias.
 */
export function setConversationKeyIfAbsent(
  conversationKey: string,
  conversationId: string,
): void {
  const db = getDb();
  db.insert(conversationKeys)
    .values({
      id: uuid(),
      conversationKey,
      conversationId,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
}

/**
 * Resolve a value that may be either a conversation ID or a conversation key
 * to the daemon's internal conversation ID.
 *
 * Returns the internal conversation ID, or `null` if neither lookup succeeds.
 * Useful for endpoints (regenerate, undo, seen) that receive IDs from clients
 * which may be conversation keys rather than internal IDs.
 */
export function resolveConversationId(idOrKey: string): string | null {
  const db = getDb();

  // Fast path: check if it's already a valid conversation ID.
  const direct = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, idOrKey))
    .get();
  if (direct) {
    return direct.id;
  }

  // Slow path: check if it's a conversation key.
  const mapping = db
    .select()
    .from(conversationKeys)
    .where(eq(conversationKeys.conversationKey, idOrKey))
    .get();
  return mapping?.conversationId ?? null;
}

/**
 * Get or create a conversation for the given conversationKey.
 *
 * If a mapping already exists, returns the existing conversation ID.
 * Otherwise, creates a new conversation and mapping atomically within a
 * single transaction to prevent race conditions and orphaned rows.
 */
export function getOrCreateConversation(
  conversationKey: string,
  opts?: {
    conversationType?: NonScheduledConversationType;
    /**
     * Caller-supplied title for the conversation, used only when this call
     * actually creates the row. Treated as a user-set title (`isAutoTitle = 0`)
     * so the async LLM title generator's safe-overwrite check leaves it
     * untouched. Ignored when the conversation already exists.
     */
    title?: string;
    /**
     * The channel this conversation originates on, stamped into
     * `origin_channel` when this call creates the row.
     *
     * This is the principal inbound materialization seam, so it is where a
     * channel conversation gets its provenance. Callers that resolve a
     * source channel before reaching here already hold the value; omitting
     * it leaves the column unset for first-message attribution, which is
     * what every caller did before this option existed.
     */
    origin?: ChannelId;
  },
): {
  conversationId: string;
  conversationType: string;
  created: boolean;
} {
  const db = getDb();
  const conversationType = opts?.conversationType ?? "standard";

  const result = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(conversationKeys)
      .where(eq(conversationKeys.conversationKey, conversationKey))
      .get();

    if (existing) {
      const conv = tx
        .select({ conversationType: conversations.conversationType })
        .from(conversations)
        .where(eq(conversations.id, existing.conversationId))
        .get();
      return {
        conversationId: existing.conversationId,
        conversationType: conv?.conversationType ?? "standard",
        created: false as const,
      };
    }

    // Check if the conversationKey itself is an existing conversation ID.
    // This happens when the client loads a conversation from the conversations list
    // and uses the server's conversationId as its local conversationKey.
    const existingConversation = tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationKey))
      .get();

    if (existingConversation) {
      tx.insert(conversationKeys)
        .values({
          id: uuid(),
          conversationKey,
          conversationId: existingConversation.id,
          createdAt: Date.now(),
        })
        .run();
      const conv = tx
        .select({ conversationType: conversations.conversationType })
        .from(conversations)
        .where(eq(conversations.id, existingConversation.id))
        .get();
      return {
        conversationId: existingConversation.id,
        conversationType: conv?.conversationType ?? "standard",
        created: false as const,
      };
    }

    // The first standard conversation is the onboarding one, so BOOTSTRAP.md
    // survives its whole duration and any later standard create means
    // onboarding is over. Background rows stay inert: a hidden side thread
    // minted before the user's first visible chat must not consume that slot.
    if (conversationType === "standard") {
      if (firstConversationSeen) {
        cleanupBootstrapFiles("new conversation created after onboarding");
      }
      firstConversationSeen = true;
    }

    const now = Date.now();
    const conversationId = uuid();
    const customTitle = opts?.title?.trim();
    const title = customTitle || GENERATING_TITLE;
    // Snapshot↔stream alignment baseline, captured at the creation instant
    // (same seed as `createConversation`; 0 is stored as NULL).
    const initialSeq = getCurrentSeq();

    tx.insert(conversations)
      .values({
        id: conversationId,
        title,
        seq: initialSeq > 0 ? initialSeq : null,
        // A caller-supplied title is user-set: mark it non-auto (0) so the
        // async LLM title generator's `canReplaceTitle` check won't overwrite
        // it. Without one, omit the column so it takes its default
        // (AUTO_TITLE_LLM) and follows the auto-generated placeholder flow.
        ...(customTitle ? { isAutoTitle: 0 } : {}),
        createdAt: now,
        updatedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        contextSummary: null,
        contextCompactedMessageCount: 0,
        contextCompactedAt: null,
        conversationType,
        originChannel: opts?.origin ?? null,
      })
      .run();

    tx.insert(conversationKeys)
      .values({
        id: uuid(),
        conversationKey,
        conversationId,
        createdAt: now,
      })
      .run();

    return {
      conversationId,
      conversationType,
      created: true as const,
      conversation: {
        id: conversationId,
        title,
        createdAt: now,
        conversationType,
        originChannel: opts?.origin ?? null,
      },
    };
  });

  if (result.created) {
    initConversationDir(result.conversation);
    // Attribution for every key-materialized conversation: this is the single
    // choke point through which all unseen-key creations flow, and the key
    // shape + caller frames identify the entry point from the log alone. The
    // raw key is never logged — channel-backed keys embed external chat ids
    // (phone numbers, Slack/Telegram ids), and assistant logs travel in
    // support bundles. Emitted only on the creation branch, never on hot
    // read/write paths.
    log.info(
      {
        conversationKeyShape: classifyConversationKey(conversationKey),
        conversationId: result.conversationId,
        conversationType,
        hasCustomTitle: Boolean(opts?.title?.trim()),
        caller: captureCallerFrames(),
      },
      "Materialized conversation for unseen conversation key",
    );
  }

  return {
    conversationId: result.conversationId,
    conversationType: result.conversationType,
    created: result.created,
  };
}

const UUID_SHAPE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PII-free shape label for a conversation key. Channel-backed keys embed
 * external chat/user ids, so only the structural prefix is kept (e.g.
 * `asst:<id>:slack:<chat>:thread:<ts>` → "asst-scoped:slack:threaded");
 * free-form keys collapse to a coarse class.
 */
function classifyConversationKey(conversationKey: string): string {
  if (conversationKey.startsWith("asst:")) {
    const parts = conversationKey.split(":");
    const channel = parts[2] ?? "unknown";
    const threaded = parts.includes("thread") ? ":threaded" : "";
    return `asst-scoped:${channel}${threaded}`;
  }
  const prefixed = conversationKey.match(/^([a-z-]+)[:-]/i);
  if (prefixed) {
    return `prefixed:${prefixed[1].toLowerCase()}`;
  }
  if (UUID_SHAPE_RE.test(conversationKey)) {
    return "uuid";
  }
  return "opaque";
}

/**
 * Compact caller summary for creation attribution: the first few stack
 * frames above this module, joined into one log-friendly line.
 */
function captureCallerFrames(): string {
  const stack = new Error().stack?.split("\n") ?? [];
  return stack
    .slice(1)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith("at ") && !line.includes("conversation-key-store"),
    )
    .slice(0, 4)
    .join(" | ");
}
