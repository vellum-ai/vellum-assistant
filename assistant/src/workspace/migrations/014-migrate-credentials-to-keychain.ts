import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migrations");

export const migrateCredentialsToKeychainMigration: WorkspaceMigration = {
  id: "014-migrate-credentials-to-keychain",
  description:
    "Copy encrypted store credentials to keychain for single-backend migration",

  async run(_workspaceDir: string): Promise<void> {
    // Only run on mac production builds (desktop app, non-dev).
    if (
      process.env.VELLUM_DESKTOP_APP !== "1" ||
      process.env.VELLUM_DEV === "1"
    ) {
      return;
    }

    const { createBrokerClient } =
      await import("../../security/keychain-broker-client.js");
    const client = createBrokerClient();

    if (!client.isAvailable()) {
      log.warn(
        "Keychain broker not available — skipping credential migration to keychain",
      );
      return;
    }

    const { listKeys, getKey, deleteKey } =
      await import("../../security/encrypted-store.js");

    const accounts = listKeys();
    if (accounts.length === 0) {
      return;
    }

    let migratedCount = 0;
    let failedCount = 0;

    for (const account of accounts) {
      const value = getKey(account);
      if (value === undefined) {
        log.warn(
          { account },
          "Failed to read key from encrypted store — skipping",
        );
        failedCount++;
        continue;
      }

      const result = await client.set(account, value);
      if (result.status === "ok") {
        deleteKey(account);
        migratedCount++;
      } else {
        log.warn(
          { account, status: result.status },
          "Failed to write key to keychain — skipping",
        );
        failedCount++;
      }
    }

    log.info(
      { migratedCount, failedCount },
      "Credential migration to keychain complete",
    );
  },
};
