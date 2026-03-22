import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migrations");

const BROKER_WAIT_INTERVAL_MS = 500;
const BROKER_WAIT_MAX_ATTEMPTS = 10; // 5 seconds total

export const migrateCredentialsToKeychainMigration: WorkspaceMigration = {
  id: "015-migrate-credentials-to-keychain",
  description:
    "Copy encrypted store credentials to keychain for single-backend migration",

  async down(_workspaceDir: string): Promise<void> {
    // Reverse: copy credentials from keychain back to encrypted store.
    // Mirrors the forward logic of 016-migrate-credentials-from-keychain.
    if (
      process.env.VELLUM_DESKTOP_APP !== "1" ||
      process.env.VELLUM_DEV === "1"
    ) {
      return;
    }

    const { createBrokerClient } =
      await import("../../security/keychain-broker-client.js");
    const client = createBrokerClient();

    let brokerAvailable = false;
    for (let i = 0; i < BROKER_WAIT_MAX_ATTEMPTS; i++) {
      if (client.isAvailable()) {
        brokerAvailable = true;
        break;
      }
      await new Promise((r) => setTimeout(r, BROKER_WAIT_INTERVAL_MS));
    }

    if (!brokerAvailable) {
      throw new Error(
        "Keychain broker not available after waiting — credential rollback " +
          "will be retried on next startup",
      );
    }

    const { setKey } = await import("../../security/encrypted-store.js");

    const accounts = await client.list();
    if (accounts.length === 0) return;

    let rolledBackCount = 0;
    let failedCount = 0;

    for (const account of accounts) {
      const result = await client.get(account);
      if (!result || !result.found || result.value === undefined) {
        log.warn(
          { account },
          "Failed to read key from keychain during rollback — skipping",
        );
        failedCount++;
        continue;
      }

      const written = setKey(account, result.value);
      if (written) {
        await client.del(account);
        rolledBackCount++;
      } else {
        log.warn(
          { account },
          "Failed to write key to encrypted store during rollback — skipping",
        );
        failedCount++;
      }
    }

    log.info(
      { rolledBackCount, failedCount },
      "Credential rollback from keychain to encrypted store complete",
    );
  },

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
      throw new Error(
        "Keychain broker not available after waiting — credential migration " +
          "will be retried on next startup",
      );
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
