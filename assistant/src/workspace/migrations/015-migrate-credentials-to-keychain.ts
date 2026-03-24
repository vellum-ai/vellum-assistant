import { execFileSync } from "node:child_process";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migrations");

// ---------------------------------------------------------------------------
// Inline macOS Keychain helpers (private to this migration)
//
// These shell out to /usr/bin/security directly, replacing the former
// keychain broker (UDS server) that was deleted in PR #21099.
// ---------------------------------------------------------------------------

const SERVICE_NAME = "vellum-assistant";

function keychainIsAvailable(): boolean {
  return process.platform === "darwin";
}

function keychainGet(account: string): string | undefined {
  try {
    const stdout = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", SERVICE_NAME, "-a", account, "-w"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return stdout.trim();
  } catch {
    return undefined;
  }
}

function keychainSet(account: string, value: string): boolean {
  try {
    execFileSync(
      "/usr/bin/security",
      [
        "add-generic-password",
        "-s",
        SERVICE_NAME,
        "-a",
        account,
        "-w",
        value,
        "-U",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    return true;
  } catch {
    return false;
  }
}

function keychainDelete(account: string): boolean {
  try {
    execFileSync(
      "/usr/bin/security",
      ["delete-generic-password", "-s", SERVICE_NAME, "-a", account],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    return true;
  } catch (err: unknown) {
    // Item not found is acceptable — treat as success
    if (err instanceof Error && err.message.includes("could not be found")) {
      return true;
    }
    return false;
  }
}

function keychainList(): string[] {
  try {
    const stdout = execFileSync("/usr/bin/security", ["dump-keychain"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });

    const blocks = stdout.split(/class: "genp"/);
    const accounts: string[] = [];

    for (const block of blocks) {
      if (!block.includes(`"svce"<blob>="${SERVICE_NAME}"`)) continue;
      const match = block.match(/"acct"<blob>="([^"]+)"/);
      if (match) {
        accounts.push(match[1]);
      }
    }

    return accounts;
  } catch {
    return [];
  }
}

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

    if (!keychainIsAvailable()) {
      return;
    }

    const { setKey } = await import("../../security/encrypted-store.js");

    const accounts = keychainList();
    if (accounts.length === 0) return;

    let rolledBackCount = 0;
    let failedCount = 0;

    for (const account of accounts) {
      const value = keychainGet(account);
      if (value === undefined) {
        log.warn(
          { account },
          "Failed to read key from keychain during rollback — skipping",
        );
        failedCount++;
        continue;
      }

      const written = setKey(account, value);
      if (written) {
        keychainDelete(account);
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

    if (!keychainIsAvailable()) {
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

      const result = keychainSet(account, value);
      if (result) {
        deleteKey(account);
        migratedCount++;
      } else {
        log.warn({ account }, "Failed to write key to keychain — skipping");
        failedCount++;
      }
    }

    log.info(
      { migratedCount, failedCount },
      "Credential migration to keychain complete",
    );
  },
};
