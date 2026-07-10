import { eq } from "drizzle-orm";

import { getDb } from "../../../persistence/db-connection.js";
import { activationSessions } from "../../../persistence/schema/index.js";
import { getLogger } from "./logging.js";

const log = getLogger("activation-session-store");

/**
 * Mark a conversation as an activation-rail session. Idempotent (the row's
 * primary key is the conversation id) and best-effort: a write failure is
 * logged and swallowed so it never blocks the turn that triggered it.
 */
export function markActivationSession(conversationId: string): void {
  try {
    getDb()
      .insert(activationSessions)
      .values({ conversationId, createdAt: Date.now() })
      .onConflictDoNothing()
      .run();
  } catch (err) {
    log.warn({ err, conversationId }, "Failed to mark activation session");
  }
}

/**
 * Whether the given conversation was started on the activation rail. Best-effort:
 * a read failure is logged and treated as "not an activation session".
 */
export function isActivationSession(conversationId: string): boolean {
  try {
    const row = getDb()
      .select({ conversationId: activationSessions.conversationId })
      .from(activationSessions)
      .where(eq(activationSessions.conversationId, conversationId))
      .limit(1)
      .get();
    return row !== undefined;
  } catch (err) {
    log.warn({ err, conversationId }, "Failed to read activation session");
    return false;
  }
}
