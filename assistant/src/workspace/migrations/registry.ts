import { avatarRenameMigration } from "./001-avatar-rename.js";
import { backfillInstallationIdMigration } from "./002-backfill-installation-id.js";
import type { WorkspaceMigration } from "./types.js";

/**
 * Ordered list of all workspace data migrations.
 * New migrations are appended to the end. Never reorder or remove entries.
 */
export const WORKSPACE_MIGRATIONS: WorkspaceMigration[] = [
  avatarRenameMigration,
  backfillInstallationIdMigration,
];
