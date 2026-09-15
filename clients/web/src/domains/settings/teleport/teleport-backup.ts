/**
 * Pre-teleport safety backup of the source assistant.
 *
 * A teleport ends with the source being retired, so the source is snapshotted
 * before any data leaves it. Any failure aborts the teleport: without a
 * restore point, retiring the source is not safe.
 *
 * - Managed (cloud) sources take a platform PVC snapshot through Django. The
 *   POST returns as soon as the snapshot object exists and it becomes
 *   restorable asynchronously, so the listing is polled until the new
 *   snapshot reports `ready_to_use`. A restorable snapshot younger than
 *   `RECENT_BACKUP_MAX_AGE_MS` stands in for a new one; platform snapshots
 *   are scoped to the assistant's own volume, so reuse cannot pick up another
 *   assistant's backup.
 * - Local sources take a gateway vbundle snapshot. The gateway's local pool
 *   is shared by every bare-metal assistant on the machine and carries no
 *   assistant identity, so an existing snapshot is never reused here: one is
 *   always taken.
 *
 * Policy shared with the CLI teleport lives in
 * `@vellumai/local-mode/teleport-backup-policy`.
 */

import {
  hasRecentBackup,
  MANAGED_BACKUP_READY_POLL_INTERVAL_MS,
  MANAGED_BACKUP_READY_TIMEOUT_MS,
  managedBackupIsReady,
  readyManagedBackupCreatedAts,
  type ManagedBackupEntry,
} from "@vellumai/local-mode/teleport-backup-policy";

import {
  assistantsBackupsCreate,
  assistantsBackupsRetrieve,
} from "@/generated/api/sdk.gen";
import { t } from "@/i18n";
import type { LockfileAssistant } from "@/runtime/local-mode-host";

import { createLocalBackup } from "./teleport-gateway-client";
import { classifyHosting, TeleportError } from "./teleport-types";

export interface SourceBackupOptions {
  /** How long to wait for a new platform snapshot to become restorable. */
  readyTimeoutMs?: number;
  /** How often to re-list platform snapshots while waiting. */
  readyPollIntervalMs?: number;
}

/**
 * Make sure the source assistant has a usable backup, taking one when it does
 * not. Throws a `backup_failed` {@link TeleportError} when the backup cannot
 * be listed, created, or does not become restorable in time.
 */
export async function ensureSourceBackup(
  source: LockfileAssistant,
  options: SourceBackupOptions = {},
): Promise<void> {
  const hosting = classifyHosting(source.cloud);
  if (hosting === "managed") {
    return ensureManagedBackup(source.assistantId, options);
  }
  if (hosting === "local") {
    return createLocalBackup(source);
  }
  throw new TeleportError(
    "backup_failed",
    t("settings:teleportCard.backupUnsupported"),
  );
}

async function listManagedBackups(
  assistantId: string,
): Promise<ManagedBackupEntry[]> {
  const list = await assistantsBackupsRetrieve({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  if (!(list.response?.ok ?? false)) {
    throw new TeleportError(
      "backup_failed",
      t("settings:teleportCard.backupListFailed", {
        status: list.response?.status ?? 0,
      }),
    );
  }
  const backups = (list.data as { backups?: ManagedBackupEntry[] } | undefined)
    ?.backups;
  return Array.isArray(backups) ? backups : [];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function ensureManagedBackup(
  assistantId: string,
  options: SourceBackupOptions,
): Promise<void> {
  const existing = await listManagedBackups(assistantId);
  if (hasRecentBackup(readyManagedBackupCreatedAts(existing))) {
    return;
  }

  const created = await assistantsBackupsCreate({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  if (!(created.response?.ok ?? false)) {
    throw new TeleportError(
      "backup_failed",
      t("settings:teleportCard.backupCreateFailed", {
        status: created.response?.status ?? 0,
      }),
    );
  }
  const snapshot = created.data as ManagedBackupEntry | undefined;
  const snapshotName = snapshot?.snapshot_name;
  if (!snapshotName) {
    throw new TeleportError(
      "backup_failed",
      t("settings:teleportCard.backupNoSnapshotName"),
    );
  }
  if (snapshot?.ready_to_use === true) {
    return;
  }

  const timeoutMs = options.readyTimeoutMs ?? MANAGED_BACKUP_READY_TIMEOUT_MS;
  const pollIntervalMs =
    options.readyPollIntervalMs ?? MANAGED_BACKUP_READY_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    if (
      managedBackupIsReady(await listManagedBackups(assistantId), snapshotName)
    ) {
      return;
    }
  }
  throw new TeleportError(
    "backup_failed",
    t("settings:teleportCard.backupNotReady", {
      snapshot: snapshotName,
      seconds: Math.round(timeoutMs / 1000),
    }),
  );
}
