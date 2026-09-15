/**
 * Pre-teleport safety backup of the source assistant.
 *
 * A teleport ends with the source being retired, so the source is snapshotted
 * before any data leaves it. Platform-managed (cloud="vellum") sources take a
 * PVC snapshot through Django's `POST /v1/assistants/<id>/backups/`; local and
 * docker sources take a gateway vbundle snapshot through the gateway's
 * `POST /v1/backups/create`. A snapshot younger than
 * {@link RECENT_BACKUP_MAX_AGE_MS} is reused instead of taking a fresh one,
 * since the gateway snapshot is a full export and would otherwise double the
 * cost of a local-to-platform teleport.
 */

import type { AssistantEntry } from "./assistant-config.js";
import { loopbackSafeFetch } from "./loopback-fetch.js";
import { authHeaders, invalidateOrgIdCache } from "./platform-client.js";

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

// ---------------------------------------------------------------------------
// Gateway (local / docker) snapshots
// ---------------------------------------------------------------------------

type GatewayEntry = Pick<AssistantEntry, "runtimeUrl">;

function gatewayHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

async function errorSuffix(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return `(${response.status})${body ? `: ${body}` : ""}`;
}

/**
 * List the `created_at` timestamps of a local/docker assistant's gateway
 * backup snapshots (local pool only): `GET /v1/backups`.
 *
 * Errors carry the `Local runtime <op> failed (<status>)` shape so the
 * teleport command's 401 refresh-and-retry wrapper recognizes them.
 */
export async function listGatewayBackups(
  entry: GatewayEntry,
  token: string,
): Promise<string[]> {
  const response = await loopbackSafeFetch(`${entry.runtimeUrl}/v1/backups`, {
    method: "GET",
    headers: gatewayHeaders(token),
  });
  if (!response.ok) {
    throw new Error(
      `Local runtime backup list failed ${await errorSuffix(response)}`,
    );
  }
  const body = (await response.json()) as {
    local?: { snapshots?: Array<{ created_at?: string }> };
  };
  return (body.local?.snapshots ?? []).map(
    (snapshot) => snapshot.created_at ?? "",
  );
}

/**
 * Take a gateway backup snapshot of a local/docker assistant now:
 * `POST /v1/backups/create`. The gateway exports a fresh `.vbundle` and
 * writes it to the local pool plus any configured offsite destinations, so
 * this call blocks for the full export.
 */
export async function createGatewayBackup(
  entry: GatewayEntry,
  token: string,
): Promise<void> {
  const response = await loopbackSafeFetch(
    `${entry.runtimeUrl}/v1/backups/create`,
    {
      method: "POST",
      headers: gatewayHeaders(token),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Local runtime backup create failed ${await errorSuffix(response)}`,
    );
  }
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
  } | null;
  if (body && body.success === false) {
    throw new Error("Local runtime backup create reported failure");
  }
}

// ---------------------------------------------------------------------------
// Platform (cloud="vellum") PVC snapshots
// ---------------------------------------------------------------------------

type PlatformEntry = Pick<AssistantEntry, "runtimeUrl" | "assistantId">;

function platformBackupsUrl(entry: PlatformEntry): string {
  return `${entry.runtimeUrl}/v1/assistants/${entry.assistantId}/backups/`;
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

/**
 * List the `created_at` timestamps of a platform assistant's ready PVC
 * snapshots: `GET /v1/assistants/<id>/backups/`. Snapshots still being cut
 * (`ready_to_use: false`) are excluded so a stuck snapshot never counts as
 * a usable restore point.
 */
export async function listPlatformBackups(
  entry: PlatformEntry,
  token: string,
): Promise<string[]> {
  const response = await platformBackupRequest(entry, token, "GET");
  if (!response.ok) {
    throw new Error(
      `Platform backup list failed ${await errorSuffix(response)}`,
    );
  }
  const body = (await response.json()) as {
    backups?: Array<{ created_at?: string; ready_to_use?: boolean }>;
  };
  return (body.backups ?? [])
    .filter((backup) => backup.ready_to_use !== false)
    .map((backup) => backup.created_at ?? "");
}

/**
 * Take a PVC snapshot of a platform assistant now:
 * `POST /v1/assistants/<id>/backups/`. Returns once the snapshot object is
 * created; it becomes restorable asynchronously.
 */
export async function createPlatformBackup(
  entry: PlatformEntry,
  token: string,
): Promise<void> {
  const response = await platformBackupRequest(entry, token, "POST");
  if (!response.ok) {
    throw new Error(
      `Platform backup create failed ${await errorSuffix(response)}`,
    );
  }
}
