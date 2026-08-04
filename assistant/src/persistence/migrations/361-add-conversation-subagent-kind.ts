import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const ROLE_COLUMN = "subagent_role";
const SPAWN_MODE_COLUMN = "subagent_spawn_mode";

/**
 * Add `subagent_role` and `subagent_spawn_mode` columns to `conversations`.
 *
 * Both are nullable, free-form strings describing the subagent that owns the
 * conversation: the role it was spawned with and how it was spawned. The
 * accepted values, and what each one means, are documented once on
 * `SubagentRole` / `SubagentSpawnMode` in `subagent/types.ts`; the columns
 * take whatever the row carried, including role names retired since. NULL for
 * every conversation that is not a subagent.
 *
 * Together they make delegated LLM spend separable. Every subagent variety
 * (a fire-and-forget spawn, a context-inheriting fork, and an advisor
 * consult) emits usage under `llm_call_site = "subagentSpawn"` in a child
 * conversation, so the largest descendant cost bucket could not be
 * decomposed. The advisor in particular is a ROLE, not a call site.
 *
 * Denormalized onto `conversations` rather than joined from `subagents` at
 * telemetry-flush time because `subagents` rows are deleted on dispose (TTL
 * sweep ~30 minutes after the run goes terminal) while usage telemetry
 * flushes on a watermark that can trail arbitrarily far behind after an
 * ingest outage. Same rationale that put `parent_conversation_id` here
 * (migration 342). No index: these are projected alongside an existing
 * primary-key join, never filtered on.
 *
 * Backfills from the `subagents` table (migration 311) for subagents that
 * have not yet been disposed, which links unflushed usage rows of
 * pre-migration subagents. The spawn mode is derived from the surviving
 * `role` / `is_fork` columns; long-disposed subagents have no surviving
 * linkage anywhere and correctly stay NULL. The derivation cannot recover
 * `voice_continuation` (the live-voice continuation is an unlabelled fork
 * pre-migration), so those rows backfill as `fork`, a small, bounded
 * inaccuracy confined to the backfill window.
 *
 * The backfill needs `subagents(conversation_id)` indexed, which migration 311
 * did not create: both statements look the `subagents` table up once per
 * `conversations` row, so unindexed they are a full scan of `subagents` per
 * row and the whole step is quadratic. Migrations run during startup and block
 * readiness, so on a long-lived assistant that is a multi-minute stall at
 * boot. The index is created here rather than appended as a later migration
 * because it has to exist BEFORE these statements run; it also serves the
 * by-conversation lookup in `subagent-store.ts`, which scanned until now.
 *
 * Idempotent: guarded with `tableHasColumn` so a crash between the `ALTER
 * TABLE` and the checkpoint write doesn't cause a duplicate-column error on
 * the next boot, `IF NOT EXISTS` on the index, and the backfill only fills
 * NULL rows for the same reason.
 */
export function migrateAddConversationSubagentKind(database: DrizzleDb): void {
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_subagents_conversation_id ON subagents(conversation_id)`,
  );
  if (!tableHasColumn(database, "conversations", ROLE_COLUMN)) {
    database.run(`ALTER TABLE conversations ADD COLUMN ${ROLE_COLUMN} TEXT`);
  }
  if (!tableHasColumn(database, "conversations", SPAWN_MODE_COLUMN)) {
    database.run(
      `ALTER TABLE conversations ADD COLUMN ${SPAWN_MODE_COLUMN} TEXT`,
    );
  }
  database.run(`
    UPDATE conversations
    SET subagent_role = (
      SELECT s.role FROM subagents s
      WHERE s.conversation_id = conversations.id
    )
    WHERE subagent_role IS NULL
      AND EXISTS (
        SELECT 1 FROM subagents s WHERE s.conversation_id = conversations.id
      )
  `);
  database.run(`
    UPDATE conversations
    SET subagent_spawn_mode = (
      SELECT CASE
        WHEN s.role = 'advisor' THEN 'advisor_consult'
        WHEN s.is_fork = 1 THEN 'fork'
        ELSE 'regular'
      END
      FROM subagents s
      WHERE s.conversation_id = conversations.id
    )
    WHERE subagent_spawn_mode IS NULL
      AND EXISTS (
        SELECT 1 FROM subagents s WHERE s.conversation_id = conversations.id
      )
  `);
}
