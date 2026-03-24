import type { WorkspaceMigration } from "./types.js";

/**
 * Originally migrated credentials from encrypted store to macOS Keychain.
 * No-op'd because: (1) the keychain broker was deleted, (2) inline security
 * CLI calls trigger macOS permission prompts on every daemon startup even for
 * users who never had keychain credentials, (3) migration 016 reverses this
 * migration anyway, so the net effect is a round-trip.
 *
 * Users who had credentials stranded in the macOS Keychain from a brief
 * intermediate release will need to re-enter their API keys.
 */
export const migrateCredentialsToKeychainMigration: WorkspaceMigration = {
  id: "015-migrate-credentials-to-keychain",
  description: "No-op (keychain migration removed)",
  async run(): Promise<void> {},
  async down(): Promise<void> {},
};
