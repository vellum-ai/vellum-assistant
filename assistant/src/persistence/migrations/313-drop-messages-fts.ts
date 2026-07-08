import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { dropFtsShadowTables } from "./116-messages-fts.js";

/**
 * Drops the `messages_fts` FTS5 virtual table and its per-row triggers
 * (`messages_fts_ai/ad/au`). Message-content search reads the sparse Qdrant
 * `messages_lexical` index (see `conversation-search-lexical.ts`), so the
 * synchronous per-row FTS maintenance — the dominant write-amplification cost
 * on `messages` for batch forks and batch deletes — carries no reader.
 *
 * Idempotent: every drop is `IF EXISTS` / individually error-swallowed, and
 * the `writable_schema` fallback inside {@link dropFtsShadowTables} handles a
 * corrupt vtable that blocks a plain `DROP TABLE`.
 */
export function migrateDropMessagesFts(database: DrizzleDb): void {
  dropFtsShadowTables(getSqliteFrom(database));
}
