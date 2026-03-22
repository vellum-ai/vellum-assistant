import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migrations");

const BROKER_WAIT_INTERVAL_MS = 500;
const BROKER_WAIT_MAX_ATTEMPTS = 10; // 5 seconds total

export const migrateCredentialsFromKeychainMigration: WorkspaceMigration = {
  id: "016-migrate-credentials-from-keychain",
  description:
    "Copy keychain credentials back to encrypted store for CES unification",

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

    // Wait for the broker to become available (up to 5 seconds), matching
    // the retry strategy in secure-keys.ts waitForBrokerAvailability().
    let brokerAvailable = false;
    for (let i = 0; i < BROKER_WAIT_MAX_ATTEMPTS; i++) {
      if (client.isAvailable()) {
        brokerAvailable = true;
        break;
      }
      await new Promise((r) => setTimeout(r, BROKER_WAIT_INTERVAL_MS));
    }

    if (!brokerAvailable) {
      // Unlike migration 015, we return silently here. If the broker is not
      // available, credentials may already be in the encrypted store from
      // before migration 015 ran, or from a non-desktop environment.
      return;
    }

    const { setKey } = await import("../../security/encrypted-store.js");

    const accounts = await client.list();
    if (accounts.length === 0) {
      return;
    }

    let migratedCount = 0;
    let failedCount = 0;

    for (const account of accounts) {
      const result = await client.get(account);
      if (!result || !result.found || result.value === undefined) {
        log.warn(
          { account },
          "Failed to read key from keychain — skipping",
        );
        failedCount++;
        continue;
      }

      const written = setKey(account, result.value);
      if (written) {
        await client.del(account);
        migratedCount++;
      } else {
        log.warn(
          { account },
          "Failed to write key to encrypted store — skipping",
        );
        failedCount++;
      }
    }

    log.info(
      { migratedCount, failedCount },
      "Credential migration from keychain complete",
    );
  },
};
