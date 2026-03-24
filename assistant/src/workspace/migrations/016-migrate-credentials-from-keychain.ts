import type { WorkspaceMigration } from "./types.js";

/**
 * Originally migrated credentials from macOS Keychain back to encrypted store.
 * No-op'd for the same reasons as migration 015 — see that file for details.
 */
export const migrateCredentialsFromKeychainMigration: WorkspaceMigration = {
  id: "016-migrate-credentials-from-keychain",
  description: "No-op (keychain migration removed)",
  async run(): Promise<void> {},
  async down(): Promise<void> {},
};
