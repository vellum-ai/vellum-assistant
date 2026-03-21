import type { WorkspaceMigration } from "./types.js";

export const backfillInstallationIdMigration: WorkspaceMigration = {
  id: "011-backfill-installation-id",
  description:
    "Backfill installationId into lockfile from SQLite checkpoint and clean up stale row",
  // This migration previously read/wrote the lockfile to backfill
  // installationId. It has already run for all existing installs and
  // is now a no-op.
  run(): void {},
};
