/**
 * Platform (cloud="vellum") half of the pre-teleport safety backup.
 *
 * A platform source is snapshotted through Django's user-facing backup
 * endpoint, which cuts a PVC VolumeSnapshot via vembda. The POST returns as
 * soon as the snapshot object exists; it becomes restorable asynchronously,
 * so {@link createPlatformBackup} polls the listing until the new snapshot
 * reports `ready_to_use` before returning. A snapshot that never becomes
 * ready within the timeout is a backup failure, not a success.
 *
 * Local and docker sources are backed up host-side by `backup-ops` instead,
 * so the restore point survives the source's retirement. Policy shared with
 * the web teleport lives in `@vellumai/local-mode/teleport-backup-policy`.
 */

import {
  MANAGED_BACKUP_READY_POLL_INTERVAL_MS,
  MANAGED_BACKUP_READY_TIMEOUT_MS,
  managedBackupIsReady,
  readyManagedBackupCreatedAts,
  type ManagedBackupEntry,
} from "@vellumai/local-mode/teleport-backup-policy";

import type { AssistantEntry } from "./assistant-config.js";
import { loopbackSafeFetch } from "./loopback-fetch.js";
import { authHeaders, invalidateOrgIdCache } from "./platform-client.js";

type PlatformEntry = Pick<AssistantEntry, "runtimeUrl" | "assistantId">;

function platformBackupsUrl(entry: PlatformEntry): string {
  return `${entry.runtimeUrl}/v1/assistants/${entry.assistantId}/backups/`;
}

async function errorSuffix(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return `(${response.status})${body ? `: ${body}` : ""}`;
}

/**
 * Send a platform backup request with user-session auth, refreshing the
 * cached organization id once on 401 (the same recovery the runtime identity
 * probe applies).
 */
async function platformBackupRequest(
  entry: PlatformEntry,
  token: string,
  method: "GET" | "POST",
): Promise<Response> {
  const doRequest = async (): Promise<Response> =>
    loopbackSafeFetch(platformBackupsUrl(entry), {
      method,
      headers: {
        ...(await authHeaders(token, entry.runtimeUrl)),
        Accept: "application/json",
      },
    });
  let response = await doRequest();
  if (response.status === 401) {
    invalidateOrgIdCache(token, entry.runtimeUrl);
    response = await doRequest();
  }
  return response;
}

async function fetchPlatformBackups(
  entry: PlatformEntry,
  token: string,
): Promise<ManagedBackupEntry[]> {
  const response = await platformBackupRequest(entry, token, "GET");
  if (!response.ok) {
    throw new Error(
      `Platform backup list failed ${await errorSuffix(response)}`,
    );
  }
  const body = (await response.json()) as { backups?: ManagedBackupEntry[] };
  return body.backups ?? [];
}

/**
 * `created_at` of every restorable PVC snapshot of a platform assistant:
 * `GET /v1/assistants/<id>/backups/`.
 */
export async function listPlatformBackups(
  entry: PlatformEntry,
  token: string,
): Promise<Array<string | undefined>> {
  return readyManagedBackupCreatedAts(await fetchPlatformBackups(entry, token));
}

export interface CreatePlatformBackupOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Take a PVC snapshot of a platform assistant and wait until it is
 * restorable: `POST /v1/assistants/<id>/backups/`, then re-list until the
 * returned `snapshot_name` reports `ready_to_use`. Throws if the POST fails
 * or the snapshot is not ready within `timeoutMs`.
 */
export async function createPlatformBackup(
  entry: PlatformEntry,
  token: string,
  options: CreatePlatformBackupOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? MANAGED_BACKUP_READY_TIMEOUT_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? MANAGED_BACKUP_READY_POLL_INTERVAL_MS;

  const response = await platformBackupRequest(entry, token, "POST");
  if (!response.ok) {
    throw new Error(
      `Platform backup create failed ${await errorSuffix(response)}`,
    );
  }
  const created = (await response.json().catch(() => null)) as {
    snapshot_name?: string;
    ready_to_use?: boolean;
  } | null;
  const snapshotName = created?.snapshot_name;
  if (!snapshotName) {
    throw new Error("Platform backup create returned no snapshot name");
  }
  if (created?.ready_to_use === true) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const backups = await fetchPlatformBackups(entry, token);
    if (managedBackupIsReady(backups, snapshotName)) {
      return;
    }
  }
  throw new Error(
    `Platform backup ${snapshotName} was not ready after ${Math.round(timeoutMs / 1000)}s`,
  );
}
