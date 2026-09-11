import { encodeBase64Bytes } from "@/utils/base64";
import {
  NOTIFICATION_AVATAR_BASE64_MAX_CHARS,
  NOTIFICATION_AVATAR_HASH_PATTERN,
  NOTIFICATION_IDENTITY_MAX_CHARS,
  NOTIFICATION_SENDER_NAME_MAX_CHARS,
  VERIFIED_NOTIFICATION_NAME_PROVENANCES,
  type NotificationAvatar as PreparedNotificationAvatar,
  type NotificationIdentity,
  type PrepareNotificationIdentityPayload,
  type ResetNotificationIdentitiesPayload,
  type VerifiedNotificationNameProvenance,
} from "@vellumai/ipc-contract";

export const NOTIFICATION_IDENTITY_SNAPSHOT_LIMIT = 32;

const GENERATION_GUARD_LIMIT = NOTIFICATION_IDENTITY_SNAPSHOT_LIMIT * 2;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const VERIFIED_NAME_PROVENANCES = new Set<VerifiedNotificationNameProvenance>(
  VERIFIED_NOTIFICATION_NAME_PROVENANCES,
);

/** A verified, process-local identity prepared for one scoped assistant. */
export interface NotificationIdentitySnapshot {
  identity: NotificationIdentity;
  scopeEpoch: number;
  identityRevision: number;
  name?: string;
  nameProvenance?: VerifiedNotificationNameProvenance;
  avatar?: PreparedNotificationAvatar;
}

interface ScopeGenerationGuard {
  latestEpoch: number;
}

interface IdentityGenerationGuard {
  scopeId: string;
  scopeEpoch: number;
  identityRevision: number;
  revisionTombstone?: boolean;
}

const snapshots = new Map<string, NotificationIdentitySnapshot>();
const scopeGenerationGuards = new Map<string, ScopeGenerationGuard>();
const identityGenerationGuards = new Map<
  string,
  IdentityGenerationGuard
>();

/** Stable, collision-free key for a scope and its assistant-local id. */
export function notificationIdentityKey(
  identity: Pick<NotificationIdentity, "scopeId" | "assistantId">,
): string {
  return JSON.stringify([identity.scopeId.trim(), identity.assistantId.trim()]);
}

function compactStableHash(value: string): string {
  const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    for (let lane = 0; lane < hashes.length; lane++) {
      hashes[lane] = Math.imul(hashes[lane]! ^ code, 0x01000193) >>> 0;
    }
  }
  return hashes.map((hash) => hash.toString(16).padStart(8, "0")).join("");
}

function localNativeSenderId(scopeId: string, assistantId: string): string {
  const owner = JSON.stringify([scopeId, assistantId]);
  const encoded = encodeBase64Bytes(new TextEncoder().encode(owner))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const namespaced = `local:${encoded}`;
  if (namespaced.length <= NOTIFICATION_IDENTITY_MAX_CHARS) {
    return namespaced;
  }
  return `local:hash:${compactStableHash(owner)}`;
}

/**
 * Build the routing identity captured before notification work becomes async.
 * A platform id stays byte-for-byte compatible with remote notifications;
 * local ids are namespaced by their connection scope.
 */
export function createNotificationIdentity(
  scopeId: string,
  assistantId: string,
  platformAssistantId?: string | null,
): NotificationIdentity | null {
  const normalizedScopeId = boundedIdentityPart(scopeId);
  const normalizedAssistantId = boundedIdentityPart(assistantId);
  const normalizedPlatformId = platformAssistantId
    ? boundedIdentityPart(platformAssistantId)
    : null;
  if (
    !normalizedScopeId ||
    !normalizedAssistantId ||
    (platformAssistantId?.trim() && !normalizedPlatformId)
  ) {
    return null;
  }
  return {
    scopeId: normalizedScopeId,
    assistantId: normalizedAssistantId,
    nativeSenderId:
      normalizedPlatformId ??
      localNativeSenderId(normalizedScopeId, normalizedAssistantId),
  };
}

export function sameNotificationIdentity(
  left: NotificationIdentity,
  right: NotificationIdentity,
): boolean {
  return (
    left.scopeId === right.scopeId &&
    left.assistantId === right.assistantId &&
    left.nativeSenderId === right.nativeSenderId
  );
}

function boundedIdentityPart(value: string): string | null {
  const trimmed = value.trim();
  return trimmed && trimmed.length <= NOTIFICATION_IDENTITY_MAX_CHARS
    ? trimmed
    : null;
}

function normalizeIdentity(
  identity: NotificationIdentity,
): NotificationIdentity | null {
  const scopeId = boundedIdentityPart(identity.scopeId);
  const assistantId = boundedIdentityPart(identity.assistantId);
  const nativeSenderId = boundedIdentityPart(identity.nativeSenderId);
  return scopeId && assistantId && nativeSenderId
    ? { scopeId, assistantId, nativeSenderId }
    : null;
}

function normalizePublishedName(
  payload: PrepareNotificationIdentityPayload,
): { name: string; provenance: VerifiedNotificationNameProvenance } | null {
  const name = payload.name?.trim();
  const provenance = payload.nameProvenance;
  if (
    !name ||
    name.length > NOTIFICATION_SENDER_NAME_MAX_CHARS ||
    !provenance ||
    !VERIFIED_NAME_PROVENANCES.has(provenance)
  ) {
    return null;
  }
  return { name, provenance };
}

function normalizePublishedAvatar(
  avatar: PreparedNotificationAvatar | undefined,
): PreparedNotificationAvatar | null {
  if (
    !avatar ||
    avatar.avatarBase64.length < 4 ||
    avatar.avatarBase64.length > NOTIFICATION_AVATAR_BASE64_MAX_CHARS ||
    !BASE64_PATTERN.test(avatar.avatarBase64) ||
    !NOTIFICATION_AVATAR_HASH_PATTERN.test(avatar.avatarHash)
  ) {
    return null;
  }
  return { ...avatar };
}

function validGeneration(scopeEpoch: number, identityRevision: number): boolean {
  return (
    Number.isSafeInteger(scopeEpoch) &&
    scopeEpoch >= 0 &&
    Number.isSafeInteger(identityRevision) &&
    identityRevision >= 0
  );
}

function setBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limit: number,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) {
      return;
    }
    map.delete(oldest);
  }
}

function acceptScopeEpoch(scopeId: string, scopeEpoch: number): boolean {
  const guard = scopeGenerationGuards.get(scopeId);
  if (guard && scopeEpoch < guard.latestEpoch) {
    return false;
  }
  if (!guard || scopeEpoch > guard.latestEpoch) {
    setBounded(
      scopeGenerationGuards,
      scopeId,
      { latestEpoch: scopeEpoch },
      GENERATION_GUARD_LIMIT,
    );
  } else {
    setBounded(
      scopeGenerationGuards,
      scopeId,
      guard,
      GENERATION_GUARD_LIMIT,
    );
  }
  return true;
}

/**
 * Publish verified name and/or avatar data. Valid fields merge independently,
 * while older scope epochs and identity revisions cannot overwrite them.
 */
export function publishNotificationIdentitySnapshot(
  payload: PrepareNotificationIdentityPayload,
): boolean {
  const identity = normalizeIdentity(payload.identity);
  if (
    !identity ||
    !validGeneration(payload.scopeEpoch, payload.identityRevision)
  ) {
    return false;
  }
  const name = normalizePublishedName(payload);
  const avatar = normalizePublishedAvatar(payload.avatar);
  if (!name && !avatar) {
    return false;
  }
  if (!acceptScopeEpoch(identity.scopeId, payload.scopeEpoch)) {
    return false;
  }

  const key = notificationIdentityKey(identity);
  const prior = snapshots.get(key);
  const generation =
    identityGenerationGuards.get(key) ??
    (prior
      ? {
          scopeId: prior.identity.scopeId,
          scopeEpoch: prior.scopeEpoch,
          identityRevision: prior.identityRevision,
        }
      : undefined);
  if (
    generation &&
    (payload.scopeEpoch < generation.scopeEpoch ||
      (payload.scopeEpoch === generation.scopeEpoch &&
        (generation.revisionTombstone
          ? payload.identityRevision <= generation.identityRevision
          : payload.identityRevision < generation.identityRevision)))
  ) {
    return false;
  }

  const canMerge =
    prior?.scopeEpoch === payload.scopeEpoch &&
    sameNotificationIdentity(prior.identity, identity);
  const snapshot: NotificationIdentitySnapshot = {
    identity,
    scopeEpoch: payload.scopeEpoch,
    identityRevision: payload.identityRevision,
    ...(canMerge && prior.name
      ? { name: prior.name, nameProvenance: prior.nameProvenance }
      : {}),
    ...(canMerge && prior.avatar ? { avatar: { ...prior.avatar } } : {}),
    ...(name ? { name: name.name, nameProvenance: name.provenance } : {}),
    ...(avatar ? { avatar } : {}),
  };

  setBounded(
    identityGenerationGuards,
    key,
    {
      scopeId: identity.scopeId,
      scopeEpoch: payload.scopeEpoch,
      identityRevision: payload.identityRevision,
    },
    GENERATION_GUARD_LIMIT,
  );
  setBounded(
    snapshots,
    key,
    snapshot,
    NOTIFICATION_IDENTITY_SNAPSHOT_LIMIT,
  );
  return true;
}

function copySnapshot(
  snapshot: NotificationIdentitySnapshot,
): NotificationIdentitySnapshot {
  return {
    ...snapshot,
    identity: { ...snapshot.identity },
    ...(snapshot.avatar ? { avatar: { ...snapshot.avatar } } : {}),
  };
}

/** Read and refresh one exact identity's process-local snapshot. */
export function getNotificationIdentitySnapshot(
  identity: NotificationIdentity,
): NotificationIdentitySnapshot | null {
  const normalized = normalizeIdentity(identity);
  if (!normalized) {
    return null;
  }
  const key = notificationIdentityKey(normalized);
  const snapshot = snapshots.get(key);
  if (!snapshot || !sameNotificationIdentity(snapshot.identity, normalized)) {
    return null;
  }
  const scopeGeneration = scopeGenerationGuards.get(normalized.scopeId);
  if (
    scopeGeneration &&
    snapshot.scopeEpoch < scopeGeneration.latestEpoch
  ) {
    snapshots.delete(key);
    return null;
  }
  const generation = identityGenerationGuards.get(key);
  if (generation) {
    setBounded(
      identityGenerationGuards,
      key,
      generation,
      GENERATION_GUARD_LIMIT,
    );
  }
  setBounded(
    snapshots,
    key,
    snapshot,
    NOTIFICATION_IDENTITY_SNAPSHOT_LIMIT,
  );
  return copySnapshot(snapshot);
}

/**
 * Invalidate one assistant or a whole scope at the supplied current epoch.
 * Targeted resets retain a revision tombstone for same-epoch race protection.
 */
export function resetNotificationIdentitySnapshots(
  payload: ResetNotificationIdentitiesPayload,
): boolean {
  const scopeId = boundedIdentityPart(payload.scopeId);
  const assistantId = payload.assistantId
    ? boundedIdentityPart(payload.assistantId)
    : null;
  if (
    !scopeId ||
    (payload.assistantId !== undefined && !assistantId) ||
    (payload.identityRevision !== undefined && !assistantId) ||
    !Number.isSafeInteger(payload.scopeEpoch) ||
    payload.scopeEpoch < 0 ||
    (payload.identityRevision !== undefined &&
      (!Number.isSafeInteger(payload.identityRevision) ||
        payload.identityRevision < 0))
  ) {
    return false;
  }

  const scopeGuard = scopeGenerationGuards.get(scopeId);
  if (scopeGuard && payload.scopeEpoch < scopeGuard.latestEpoch) {
    return false;
  }
  if (assistantId) {
    const key = notificationIdentityKey({ scopeId, assistantId });
    const priorGeneration = identityGenerationGuards.get(key);
    const priorSnapshot = snapshots.get(key);
    const latestKnownRevision = Math.max(
      priorGeneration?.scopeEpoch === payload.scopeEpoch
        ? priorGeneration.identityRevision
        : -1,
      priorSnapshot?.scopeEpoch === payload.scopeEpoch
        ? priorSnapshot.identityRevision
        : -1,
    );
    snapshots.delete(key);
    setBounded(
      identityGenerationGuards,
      key,
      {
        scopeId,
        scopeEpoch: payload.scopeEpoch,
        identityRevision: Math.max(
          payload.identityRevision ?? -1,
          latestKnownRevision,
        ),
        revisionTombstone: true,
      },
      GENERATION_GUARD_LIMIT,
    );
    setBounded(
      scopeGenerationGuards,
      scopeId,
      { latestEpoch: payload.scopeEpoch },
      GENERATION_GUARD_LIMIT,
    );
    return true;
  }

  for (const [key, snapshot] of snapshots) {
    if (snapshot.identity.scopeId === scopeId) {
      snapshots.delete(key);
    }
  }
  for (const [key, guard] of identityGenerationGuards) {
    if (guard.scopeId === scopeId) {
      identityGenerationGuards.delete(key);
    }
  }
  setBounded(
    scopeGenerationGuards,
    scopeId,
    { latestEpoch: payload.scopeEpoch },
    GENERATION_GUARD_LIMIT,
  );
  return true;
}

/** Test/process teardown only. Runtime invalidation uses the guarded reset API. */
export function __clearNotificationIdentitySnapshotsForTests(): void {
  snapshots.clear();
  scopeGenerationGuards.clear();
  identityGenerationGuards.clear();
}

/**
 * The notification avatar the Electron host posts as the sender's icon, held
 * for the one module that needs it.
 *
 * Published rather than subscribed, like `use-island-avatar-source.ts`:
 * `postLocalNotification` runs outside React, and the alternative is a canvas
 * draw per notification for a picture that only changes when the avatar does.
 * Nothing here reaches the host; `runtime/notifications.ts` attaches what is
 * held to the IPC payload it is already sending.
 *
 * Empty is the ordinary state. Off Electron, with `push-avatar-sender` off, or
 * for an assistant with no avatar, nothing is stored and notifications keep
 * their app-icon look.
 */
export interface NotificationAvatar {
  /**
   * The assistant this picture was drawn for. `senderPayload()` refuses a face
   * that was not drawn for the notification's own assistant, so after a switch
   * the new assistant's name cannot be sent with the old one's face.
   */
  assistantId: string;
  /** The disc PNG as base64, with no data-URI prefix. */
  avatarBase64: string;
  /** SHA-256 of the PNG bytes, lowercase hex, so a host can name a cache file by it. */
  avatarHash: string;
}

let current: NotificationAvatar | null = null;

export function setNotificationAvatar(
  assistantId: string,
  png: Uint8Array,
  hash: string,
): void {
  current = {
    assistantId,
    avatarBase64: encodeBase64Bytes(png),
    avatarHash: hash,
  };
}

export function getNotificationAvatar(): NotificationAvatar | null {
  return current;
}

export function clearNotificationAvatar(): void {
  current = null;
}

/** Lowercase hex SHA-256 of `bytes`. */
export async function sha256Hex(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
