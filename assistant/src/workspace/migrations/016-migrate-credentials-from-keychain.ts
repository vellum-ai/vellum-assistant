import { execFileSync } from "node:child_process";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migrations");

// ---------------------------------------------------------------------------
// Inline macOS Keychain helpers (security CLI)
//
// Intentionally duplicated from 015 — each migration must be fully
// self-contained so it can run independently even if surrounding code changes.
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
    // Item-not-found is acceptable (already deleted)
    if (
      err instanceof Error &&
      "stderr" in err &&
      typeof (err as { stderr: unknown }).stderr === "string" &&
      (err as { stderr: string }).stderr.includes("could not be found")
    ) {
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

    const blocks = stdout.split('class: "genp"');
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

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export const migrateCredentialsFromKeychainMigration: WorkspaceMigration = {
  id: "016-migrate-credentials-from-keychain",
  description:
    "Copy keychain credentials back to encrypted store for CES unification",

  async down(_workspaceDir: string): Promise<void> {
    // Reverse: copy credentials from encrypted store back to keychain.
    // Mirrors the forward logic of 015-migrate-credentials-to-keychain.
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
    if (accounts.length === 0) return;

    let rolledBackCount = 0;
    let failedCount = 0;

    for (const account of accounts) {
      const value = getKey(account);
      if (value === undefined) {
        log.warn(
          { account },
          "Failed to read key from encrypted store during rollback — skipping",
        );
        failedCount++;
        continue;
      }

      if (keychainSet(account, value)) {
        deleteKey(account);
        rolledBackCount++;
      } else {
        log.warn(
          { account },
          "Failed to write key to keychain during rollback — skipping",
        );
        failedCount++;
      }
    }

    log.info(
      { rolledBackCount, failedCount },
      "Credential rollback from encrypted store to keychain complete",
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

    const { setKey } = await import("../../security/encrypted-store.js");

    const accounts = keychainList();
    if (accounts.length === 0) {
      return;
    }

    let migratedCount = 0;
    let failedCount = 0;

    for (const account of accounts) {
      const value = keychainGet(account);
      if (value === undefined) {
        log.warn({ account }, "Failed to read key from keychain — skipping");
        failedCount++;
        continue;
      }

      const written = setKey(account, value);
      if (written) {
        keychainDelete(account);
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
