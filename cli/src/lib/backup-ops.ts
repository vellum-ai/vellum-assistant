import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

import { loadGuardianToken, leaseGuardianToken } from "./guardian-token.js";

/** Default backup directory following XDG convention */
export function getBackupsDir(): string {
  const dataHome =
    process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(dataHome, "vellum", "backups");
}

/** Human-readable file size */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Obtain a valid guardian access token (cached or fresh lease) */
async function getGuardianAccessToken(
  runtimeUrl: string,
  assistantId: string,
  forceRefresh?: boolean,
): Promise<string> {
  if (!forceRefresh) {
    const tokenData = loadGuardianToken(assistantId);
    if (tokenData && new Date(tokenData.accessTokenExpiresAt) > new Date()) {
      return tokenData.accessToken;
    }
  }
  const freshToken = await leaseGuardianToken(runtimeUrl, assistantId);
  return freshToken.accessToken;
}

/**
 * Create a .vbundle backup of a running assistant.
 * Returns the path to the saved backup, or null if backup failed.
 * Never throws — failures are logged as warnings.
 */
export async function createBackup(
  runtimeUrl: string,
  assistantId: string,
  options?: { prefix?: string; description?: string },
): Promise<string | null> {
  try {
    let accessToken = await getGuardianAccessToken(runtimeUrl, assistantId);

    let response = await fetch(`${runtimeUrl}/v1/migrations/export`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: options?.description ?? "CLI backup",
      }),
      signal: AbortSignal.timeout(120_000),
    });

    // Retry once with a fresh token on 401 — the cached token may be stale
    // after a container restart that generated a new gateway signing key.
    if (response.status === 401) {
      accessToken = await getGuardianAccessToken(runtimeUrl, assistantId, true);
      response = await fetch(`${runtimeUrl}/v1/migrations/export`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          description: options?.description ?? "CLI backup",
        }),
        signal: AbortSignal.timeout(120_000),
      });
    }

    if (!response.ok) {
      const body = await response.text();
      console.warn(
        `Warning: backup export failed (${response.status}): ${body}`,
      );
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);

    const isoTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const prefix = options?.prefix ?? assistantId;
    const outputPath = join(
      getBackupsDir(),
      `${prefix}-${isoTimestamp}.vbundle`,
    );

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, data);

    return outputPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: backup failed: ${msg}`);
    return null;
  }
}

/**
 * Restore a .vbundle backup into a running assistant.
 * Returns true if restore succeeded, false otherwise.
 * Never throws — failures are logged as warnings.
 */
export async function restoreBackup(
  runtimeUrl: string,
  assistantId: string,
  backupPath: string,
): Promise<boolean> {
  try {
    if (!existsSync(backupPath)) {
      console.warn(`Warning: backup file not found: ${backupPath}`);
      return false;
    }

    const bundleData = readFileSync(backupPath);
    let accessToken = await getGuardianAccessToken(runtimeUrl, assistantId);

    let response = await fetch(`${runtimeUrl}/v1/migrations/import`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: bundleData,
      signal: AbortSignal.timeout(120_000),
    });

    // Retry once with a fresh token on 401 — the cached token may be stale
    // after a container restart that generated a new gateway signing key.
    if (response.status === 401) {
      accessToken = await getGuardianAccessToken(runtimeUrl, assistantId, true);
      response = await fetch(`${runtimeUrl}/v1/migrations/import`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/octet-stream",
        },
        body: bundleData,
        signal: AbortSignal.timeout(120_000),
      });
    }

    if (!response.ok) {
      const body = await response.text();
      console.warn(`Warning: restore failed (${response.status}): ${body}`);
      return false;
    }

    const result = (await response.json()) as {
      success: boolean;
      message?: string;
      reason?: string;
    };
    if (!result.success) {
      console.warn(
        `Warning: restore failed — ${result.message ?? result.reason ?? "unknown reason"}`,
      );
      return false;
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: restore failed: ${msg}`);
    return false;
  }
}

/**
 * Find the most recent pre-upgrade backup for an assistant.
 * Looks for files matching `{assistantId}-pre-upgrade-*.vbundle` in the backups dir.
 */
export function findLatestPreUpgradeBackup(assistantId: string): string | null {
  const backupsDir = getBackupsDir();
  if (!existsSync(backupsDir)) return null;

  const prefix = `${assistantId}-pre-upgrade-`;
  const entries = readdirSync(backupsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".vbundle"))
    .sort();

  if (entries.length === 0) return null;

  // Lexicographic sort puts ISO timestamps in chronological order; last = most recent
  return join(backupsDir, entries[entries.length - 1]);
}

/**
 * Keep only the N most recent pre-upgrade backups for an assistant,
 * deleting older ones. Default: keep 3.
 */
export function pruneOldBackups(assistantId: string, keep: number = 3): void {
  const backupsDir = getBackupsDir();
  if (!existsSync(backupsDir)) return;

  const prefix = `${assistantId}-pre-upgrade-`;
  const entries = readdirSync(backupsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".vbundle"))
    .sort();

  if (entries.length <= keep) return;

  const toDelete = entries.slice(0, entries.length - keep);
  for (const file of toDelete) {
    try {
      unlinkSync(join(backupsDir, file));
    } catch {
      // Best-effort cleanup — ignore errors
    }
  }
}
