import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

import { getRootDir } from "../util/platform.js";
import { migrationLog } from "./log.js";

/**
 * Migrate files from the old flat ~/.vellum layout to the new structured
 * layout with data/ and protected/ subdirectories.
 *
 * Idempotent: skips items that have already been migrated.
 * Uses renameSync for atomic moves (same filesystem).
 */
export function migrateToDataLayout(): void {
  const root = getRootDir();
  const data = join(root, "data");

  if (!existsSync(root)) return;

  function migrateItem(oldPath: string, newPath: string): void {
    if (!existsSync(oldPath)) return;
    if (existsSync(newPath)) return;
    try {
      const newDir = dirname(newPath);
      if (!existsSync(newDir)) {
        mkdirSync(newDir, { recursive: true });
      }
      renameSync(oldPath, newPath);
      migrationLog("info", "Migrated path", { from: oldPath, to: newPath });
    } catch (err) {
      migrationLog("warn", "Failed to migrate path", {
        err: String(err),
        from: oldPath,
        to: newPath,
      });
    }
  }

  // DB: ~/.vellum/data/assistant.db → ~/.vellum/data/db/assistant.db
  migrateItem(join(data, "assistant.db"), join(data, "db", "assistant.db"));
  migrateItem(
    join(data, "assistant.db-wal"),
    join(data, "db", "assistant.db-wal"),
  );
  migrateItem(
    join(data, "assistant.db-shm"),
    join(data, "db", "assistant.db-shm"),
  );

  // Qdrant PID: ~/.vellum/qdrant.pid → ~/.vellum/data/qdrant/qdrant.pid
  migrateItem(join(root, "qdrant.pid"), join(data, "qdrant", "qdrant.pid"));

  // Qdrant binary: ~/.vellum/bin/ → ~/.vellum/data/qdrant/bin/
  // Only migrate if the directory actually contains a qdrant binary.
  // After the CLI-launcher feature landed, ~/.vellum/bin/ is used for
  // launcher scripts (doordash, map, etc.), not qdrant, so moving it
  // blindly would break CLI launchers on every fresh hatch.
  const legacyBinDir = join(root, "bin");
  if (existsSync(join(legacyBinDir, "qdrant"))) {
    migrateItem(legacyBinDir, join(data, "qdrant", "bin"));
  }

  // Logs: ~/.vellum/logs/ → ~/.vellum/data/logs/
  migrateItem(join(root, "logs"), join(data, "logs"));

  // Memory: ~/.vellum/memory/ → ~/.vellum/data/memory/
  migrateItem(join(root, "memory"), join(data, "memory"));

  // Apps: ~/.vellum/apps/ → ~/.vellum/data/apps/
  migrateItem(join(root, "apps"), join(data, "apps"));

  // Browser auth: ~/.vellum/browser-auth/ → ~/.vellum/data/browser-auth/
  migrateItem(join(root, "browser-auth"), join(data, "browser-auth"));

  // Browser profile: ~/.vellum/browser-profile/ → ~/.vellum/data/browser-profile/
  migrateItem(join(root, "browser-profile"), join(data, "browser-profile"));

  // History: ~/.vellum/history → ~/.vellum/data/history
  migrateItem(join(root, "history"), join(data, "history"));

  // Protected files: ~/.vellum/X → ~/.vellum/protected/X
  const protectedDir = join(root, "protected");
  migrateItem(join(root, "trust.json"), join(protectedDir, "trust.json"));
  migrateItem(join(root, "keys.enc"), join(protectedDir, "keys.enc"));
  migrateItem(
    join(root, "secret-allowlist.json"),
    join(protectedDir, "secret-allowlist.json"),
  );
}
