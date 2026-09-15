/**
 * Pre-teleport safety backup of the source assistant.
 *
 * A teleport ends with the source being retired, so the source is snapshotted
 * before any data leaves it. Managed (cloud) sources take a platform PVC
 * snapshot through Django; local sources take a gateway vbundle snapshot. A
 * snapshot younger than {@link RECENT_BACKUP_MAX_AGE_MS} is reused instead of
 * taking a fresh one, since the local snapshot is a full export and would
 * otherwise double the cost of a local-to-cloud teleport. Any failure aborts
 * the teleport: without a restore point, retiring the source is not safe.
 */

import {
  assistantsBackupsCreate,
  assistantsBackupsRetrieve,
} from "@/generated/api/sdk.gen";
import type { LockfileAssistant } from "@/runtime/local-mode-host";

import { createLocalBackup, listLocalBackups } from "./teleport-gateway-client";
import { classifyHosting, TeleportError } from "./teleport-types";

/** A backup at most this old satisfies the pre-teleport backup requirement. */
export const RECENT_BACKUP_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Whether any of `createdAts` (ISO-8601 timestamps; unparseable values are
 * ignored) falls within `maxAgeMs` of `now`.
 */
export function hasRecentBackup(
  createdAts: Iterable<string | null | undefined>,
  now: number = Date.now(),
  maxAgeMs: number = RECENT_BACKUP_MAX_AGE_MS,
): boolean {
  for (const createdAt of createdAts) {
    if (!createdAt) {
      continue;
    }
    const createdMs = Date.parse(createdAt);
    if (Number.isNaN(createdMs)) {
      continue;
    }
    const age = now - createdMs;
    if (age >= 0 && age <= maxAgeMs) {
      return true;
    }
  }
  return false;
}

/**
 * Make sure the source assistant has a recent backup, taking one when it does
 * not. Throws a `backup_failed` {@link TeleportError} when the backup cannot
 * be listed or created.
 */
export async function ensureSourceBackup(
  source: LockfileAssistant,
): Promise<void> {
  const hosting = classifyHosting(source.cloud);
  if (hosting === "managed") {
    return ensureManagedBackup(source.assistantId);
  }
  if (hosting === "local") {
    return ensureLocalBackup(source);
  }
  throw new TeleportError(
    "backup_failed",
    "This assistant cannot be backed up before teleporting.",
  );
}

interface ManagedBackupEntry {
  created_at?: string;
  ready_to_use?: boolean;
}

async function ensureManagedBackup(assistantId: string): Promise<void> {
  const list = await assistantsBackupsRetrieve({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  if (!(list.response?.ok ?? false)) {
    throw new TeleportError(
      "backup_failed",
      `Could not list cloud backups (HTTP ${list.response?.status ?? 0}).`,
    );
  }
  const backups = (list.data as { backups?: ManagedBackupEntry[] } | undefined)
    ?.backups;
  const readyBackups = Array.isArray(backups)
    ? backups.filter((backup) => backup.ready_to_use !== false)
    : [];
  if (hasRecentBackup(readyBackups.map((backup) => backup.created_at))) {
    return;
  }

  const created = await assistantsBackupsCreate({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  if (!(created.response?.ok ?? false)) {
    throw new TeleportError(
      "backup_failed",
      `Cloud backup failed (HTTP ${created.response?.status ?? 0}).`,
    );
  }
}

async function ensureLocalBackup(source: LockfileAssistant): Promise<void> {
  const snapshots = await listLocalBackups(source);
  if (hasRecentBackup(snapshots.map((snapshot) => snapshot.created_at))) {
    return;
  }
  await createLocalBackup(source);
}
