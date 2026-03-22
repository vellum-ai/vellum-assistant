import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_drop_capability_card_state_v1";

/**
 * Remove persisted capability-card state after the card feed was deleted.
 *
 * Conversation starters remain in place, but card rows, category relevance
 * state, and queued generation jobs are dead data and should not survive.
 */
export function migrateDropCapabilityCardState(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    const conversationStartersExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_starters'`,
      )
      .get();
    if (conversationStartersExists) {
      raw.exec(
        /*sql*/ `DELETE FROM conversation_starters WHERE card_type = 'card'`,
      );
    }

    raw.exec(
      /*sql*/ `DELETE FROM memory_jobs WHERE type = 'generate_capability_cards'`,
    );
    raw.exec(
      /*sql*/ `DELETE FROM memory_checkpoints WHERE key LIKE 'capability_cards:%'`,
    );
    raw.exec(/*sql*/ `DROP TABLE IF EXISTS capability_card_categories`);
  });
}

/**
 * Reverse: no-op.
 *
 * The forward migration deleted rows (card-type conversation starters,
 * generate_capability_cards jobs, capability_cards checkpoints) and dropped
 * the capability_card_categories table. The deleted data cannot be restored
 * — it was discarded as dead state after the capability card feature was
 * removed.
 */
export function migrateDropCapabilityCardStateDown(_database: DrizzleDb): void {
  // No-op — see comment above.
}
