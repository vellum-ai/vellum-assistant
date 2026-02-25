import type { DrizzleDb } from '../db-connection.js';
import { migrateGuardianActionTables } from './013-guardian-action-tables.js';
import { migrateMemoryFtsBackfill } from './003-memory-fts-backfill.js';
import { migrateMemorySegmentsIndexes } from './016-memory-segments-indexes.js';
import { migrateMemoryItemsIndexes } from './017-memory-items-indexes.js';
import { migrateRemainingTableIndexes } from './018-remaining-table-indexes.js';
import { migrateRenameChannelToVellum } from './020-rename-macos-ios-channel-to-vellum.js';
import { migrateConversationStatusIndexes } from './021-conversation-status-indexes.js';
import { migrateAddOriginInterface } from './022-add-origin-interface.js';
import { migrateMemoryItemSourcesIndexes } from './023-memory-item-sources-indexes.js';
import { migrateEmbeddingVectorBlob } from './024-embedding-vector-blob.js';

/**
 * Late-stage migrations that must run after all tables and indexes exist:
 * guardian action tables, FTS backfill, index migrations, and channel renames.
 */
export function runLateMigrations(database: DrizzleDb): void {
  migrateGuardianActionTables(database);
  migrateMemoryFtsBackfill(database);
  migrateMemorySegmentsIndexes(database);
  migrateMemoryItemsIndexes(database);
  migrateRemainingTableIndexes(database);
  migrateRenameChannelToVellum(database);
  migrateConversationStatusIndexes(database);
  migrateAddOriginInterface(database);
  migrateMemoryItemSourcesIndexes(database);
  migrateEmbeddingVectorBlob(database);
}
