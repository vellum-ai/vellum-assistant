/**
 * Pre-teleport backup policy shared by every teleport surface (CLI and web).
 *
 * A teleport ends with the source assistant being retired, so each surface
 * snapshots the source before any data leaves it. This module holds the
 * decisions those surfaces must agree on: how fresh an existing backup has to
 * be to stand in for a new one, and how a platform (PVC) snapshot is judged
 * restorable. Transport lives with each client; nothing here touches the
 * network or the filesystem.
 */

/** A backup at most this old satisfies the pre-teleport backup requirement. */
export const RECENT_BACKUP_MAX_AGE_MS = 60 * 60 * 1000;

/** How long to wait for a freshly cut platform snapshot to become restorable. */
export const MANAGED_BACKUP_READY_TIMEOUT_MS = 10 * 60 * 1000;

/** How often to re-list platform snapshots while waiting for readiness. */
export const MANAGED_BACKUP_READY_POLL_INTERVAL_MS = 5_000;

/**
 * Whether any of `createdAts` (ISO-8601 timestamps; empty, missing and
 * unparseable values are ignored) falls within `maxAgeMs` of `now`.
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

/** The fields of a platform backup listing entry the policy reads. */
export interface ManagedBackupEntry {
  snapshot_name?: string;
  created_at?: string;
  ready_to_use?: boolean;
}

/**
 * `created_at` of every restorable platform snapshot. A snapshot still being
 * cut (`ready_to_use: false`) never counts as a usable restore point.
 */
export function readyManagedBackupCreatedAts(
  backups: readonly ManagedBackupEntry[],
): Array<string | undefined> {
  return backups
    .filter((backup) => backup.ready_to_use !== false)
    .map((backup) => backup.created_at);
}

/** Whether the listing shows `snapshotName` as restorable. */
export function managedBackupIsReady(
  backups: readonly ManagedBackupEntry[],
  snapshotName: string,
): boolean {
  return backups.some(
    (backup) =>
      backup.snapshot_name === snapshotName && backup.ready_to_use === true,
  );
}

/**
 * Grammar of a gateway pinned-pool label: one safe path segment. Mirrors the
 * gateway's own check in `gateway/src/backup/paths.ts`.
 */
export const PIN_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const PIN_LABEL_HASH_HEX_CHARS = 16;
const PIN_LABEL_READABLE_MAX_CHARS = 128 - 1 - PIN_LABEL_HASH_HEX_CHARS;

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * The pinned-pool label for an assistant id. An id that already is a valid
 * label is used verbatim so the pool directory stays recognizable. Any other
 * id (spaces, Unicode, too long, leading punctuation) becomes a readable
 * sanitized prefix plus a SHA-256 fragment, so distinct ids never share a
 * pool and the result always satisfies {@link PIN_LABEL_RE}.
 */
export async function pinLabelForAssistant(
  assistantId: string,
): Promise<string> {
  if (PIN_LABEL_RE.test(assistantId)) {
    return assistantId;
  }
  const readable = assistantId
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, PIN_LABEL_READABLE_MAX_CHARS);
  const hash = (await sha256Hex(assistantId)).slice(
    0,
    PIN_LABEL_HASH_HEX_CHARS,
  );
  return readable ? `${readable}-${hash}` : hash;
}
