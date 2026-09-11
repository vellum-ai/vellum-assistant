import { encodeBase64Bytes } from "@/utils/base64";
import { isUuid } from "@/utils/uuid";
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
const SCOPE_GENERATION_LIMIT = GENERATION_GUARD_LIMIT;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const OPAQUE_NOTIFICATION_SCOPE_PATTERN = /^scope:v1:[a-f0-9]{64}$/;
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
  sealedEpoch?: number;
}

interface IdentityGenerationGuard {
  scopeId: string;
  scopeEpoch: number;
  identityRevision: number;
  revisionTombstone?: boolean;
}

const snapshots = new Map<string, NotificationIdentitySnapshot>();
const scopeGenerationGuards = new Map<string, ScopeGenerationGuard>();
const identityGenerationGuards = new Map<string, IdentityGenerationGuard>();

const PUBLICATION_SCOPE_LIMIT = SCOPE_GENERATION_LIMIT;
const PUBLICATION_IDENTITY_LIMIT = GENERATION_GUARD_LIMIT;

interface PublicationScope {
  scopeEpoch: number;
  revisions: Map<string, { revision: number; active: boolean }>;
}

export type NotificationIdentityScopeInput =
  | {
      kind: "account";
      accountId: string | null;
      organizationId: string | null;
    }
  | { kind: "connection"; url: string | null };

export interface NotificationIdentityOwner {
  scopeId: string;
  assistantId: string;
}

/** Generation captured before compositor work begins. */
export interface NotificationIdentityPublication {
  identity: NotificationIdentity;
  scopeEpoch: number;
  identityRevision: number;
}

/** Optional native process-memory sink supplied by desktop/mobile runtimes. */
export interface NotificationIdentityNativeAdapter {
  prepareIdentity?(
    payload: PrepareNotificationIdentityPayload,
  ): Promise<void> | void;
  resetIdentities?(
    payload: ResetNotificationIdentitiesPayload,
  ): Promise<void> | void;
}

const publicationScopes = new Map<string, PublicationScope>();
let publicationEpoch = 0;
let publicationSessionGeneration = 0;
let installedNativeAdapter: NotificationIdentityNativeAdapter | null = null;

/** Stable, collision-free key for a scope and its assistant-local id. */
export function notificationIdentityKey(
  identity: Pick<NotificationIdentity, "scopeId" | "assistantId">,
): string {
  return JSON.stringify([identity.scopeId.trim(), identity.assistantId.trim()]);
}

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
  0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
  0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
  0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

function sha256Text(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index++) {
      const word15 = words[index - 15]!;
      const word2 = words[index - 2]!;
      const sigma0 =
        rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 =
        rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] =
        (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const sum1 =
        rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choose = (e! & f!) ^ (~e! & g!);
      const temp1 =
        (h! +
          sum1 +
          choose +
          SHA256_ROUND_CONSTANTS[index]! +
          words[index]!) >>>
        0;
      const sum0 =
        rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join(
    "",
  );
}

/** Derive an opaque deterministic scope without exposing its trusted inputs. */
export function resolveNotificationIdentityScope(
  scope: NotificationIdentityScopeInput | null,
): string | null {
  if (!scope) {
    return null;
  }
  let canonical: string | null = null;
  if (scope.kind === "account") {
    const accountId = scope.accountId?.trim();
    const organizationId = scope.organizationId?.trim();
    if (accountId && organizationId) {
      canonical = JSON.stringify(["account", accountId, organizationId]);
    }
  } else {
    const rawUrl = scope.url?.trim();
    if (rawUrl) {
      try {
        const origin = new URL(
          rawUrl,
          typeof globalThis.location === "undefined"
            ? undefined
            : globalThis.location.href,
        ).origin;
        if (origin !== "null") {
          canonical = JSON.stringify(["connection", origin]);
        }
      } catch {
        canonical = null;
      }
    }
  }
  if (!canonical || canonical.length > 4096) {
    return null;
  }
  return `scope:v1:${sha256Text(canonical)}`;
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
  const platformIdCandidate = platformAssistantId?.trim();
  const normalizedPlatformId =
    platformIdCandidate && isUuid(platformIdCandidate)
      ? platformIdCandidate
      : null;
  if (!normalizedScopeId || !normalizedAssistantId) {
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

function validGeneration(
  scopeEpoch: number,
  identityRevision: number,
): boolean {
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

function clearScopeIdentityState(scopeId: string): void {
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
}

function sealScope(scopeId: string): void {
  const scope = scopeGenerationGuards.get(scopeId);
  if (!scope) {
    return;
  }
  clearScopeIdentityState(scopeId);
  scopeGenerationGuards.set(scopeId, {
    latestEpoch: scope.latestEpoch,
    sealedEpoch: Math.max(scope.sealedEpoch ?? -1, scope.latestEpoch),
  });
}

function updateScopeEpoch(
  scopeId: string,
  scopeEpoch: number,
): { state: ScopeGenerationGuard; advanced: boolean } | null {
  const guard = scopeGenerationGuards.get(scopeId);
  if (!guard) {
    if (scopeGenerationGuards.size >= SCOPE_GENERATION_LIMIT) {
      return null;
    }
    const state = { latestEpoch: scopeEpoch };
    scopeGenerationGuards.set(scopeId, state);
    return { state, advanced: true };
  }
  if (scopeEpoch < guard.latestEpoch) {
    return null;
  }
  if (scopeEpoch > guard.latestEpoch) {
    clearScopeIdentityState(scopeId);
    const state = { latestEpoch: scopeEpoch };
    scopeGenerationGuards.set(scopeId, state);
    return { state, advanced: true };
  }
  return { state: guard, advanced: false };
}

function acceptScopeEpoch(scopeId: string, scopeEpoch: number): boolean {
  const update = updateScopeEpoch(scopeId, scopeEpoch);
  return Boolean(
    update &&
    (update.state.sealedEpoch === undefined ||
      scopeEpoch > update.state.sealedEpoch),
  );
}

function setIdentityGenerationGuard(
  key: string,
  generation: IdentityGenerationGuard,
): boolean {
  if (!identityGenerationGuards.has(key)) {
    while (identityGenerationGuards.size >= GENERATION_GUARD_LIMIT) {
      const oldest = identityGenerationGuards.values().next().value as
        IdentityGenerationGuard | undefined;
      if (!oldest) {
        break;
      }
      sealScope(oldest.scopeId);
    }
  }
  const scope = scopeGenerationGuards.get(generation.scopeId);
  if (
    !scope ||
    (scope.sealedEpoch !== undefined &&
      generation.scopeEpoch <= scope.sealedEpoch)
  ) {
    return false;
  }
  identityGenerationGuards.delete(key);
  identityGenerationGuards.set(key, generation);
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

  const nextGeneration = {
    scopeId: identity.scopeId,
    scopeEpoch: payload.scopeEpoch,
    identityRevision: payload.identityRevision,
  };
  if (!setIdentityGenerationGuard(key, nextGeneration)) {
    return false;
  }
  setBounded(snapshots, key, snapshot, NOTIFICATION_IDENTITY_SNAPSHOT_LIMIT);
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
  if (scopeGeneration && snapshot.scopeEpoch < scopeGeneration.latestEpoch) {
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
  setBounded(snapshots, key, snapshot, NOTIFICATION_IDENTITY_SNAPSHOT_LIMIT);
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

  const scopeUpdate = updateScopeEpoch(scopeId, payload.scopeEpoch);
  if (!scopeUpdate) {
    return false;
  }
  if (assistantId) {
    if (
      scopeUpdate.state.sealedEpoch !== undefined &&
      payload.scopeEpoch <= scopeUpdate.state.sealedEpoch
    ) {
      return true;
    }
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
    if (
      payload.identityRevision !== undefined &&
      payload.identityRevision < latestKnownRevision
    ) {
      return false;
    }
    snapshots.delete(key);
    const nextGeneration = {
      scopeId,
      scopeEpoch: payload.scopeEpoch,
      identityRevision: Math.max(
        payload.identityRevision ?? -1,
        latestKnownRevision,
      ),
      revisionTombstone: true,
    };
    setIdentityGenerationGuard(key, nextGeneration);
    return true;
  }

  clearScopeIdentityState(scopeId);
  if (!scopeUpdate.advanced) {
    scopeGenerationGuards.set(scopeId, {
      latestEpoch: payload.scopeEpoch,
      sealedEpoch: payload.scopeEpoch,
    });
  }
  return true;
}

function nextPublicationEpoch(minimumExclusive = -1): number {
  publicationEpoch = Math.max(publicationEpoch + 1, minimumExclusive + 1);
  return publicationEpoch;
}

function nativeNotificationIdentityAdapter(): NotificationIdentityNativeAdapter | null {
  if (installedNativeAdapter) {
    return installedNativeAdapter;
  }
  const notifications = (
    globalThis as typeof globalThis & {
      window?: {
        vellum?: { notifications?: NotificationIdentityNativeAdapter };
      };
    }
  ).window?.vellum?.notifications;
  return notifications ?? null;
}

function invokeNativeIdentityAdapter(
  operation: "prepareIdentity" | "resetIdentities",
  payload:
    | PrepareNotificationIdentityPayload
    | ResetNotificationIdentitiesPayload,
): void {
  const scopeId =
    operation === "prepareIdentity"
      ? (payload as PrepareNotificationIdentityPayload).identity.scopeId
      : (payload as ResetNotificationIdentitiesPayload).scopeId;
  if (!OPAQUE_NOTIFICATION_SCOPE_PATTERN.test(scopeId)) {
    return;
  }
  const adapter = nativeNotificationIdentityAdapter();
  const method = adapter?.[operation];
  if (!method) {
    return;
  }
  try {
    const result = method.call(adapter, payload as never);
    void Promise.resolve(result).catch(() => {});
  } catch {
    // An older or unavailable native host leaves the renderer snapshot usable.
  }
}

/** Install the process-memory adapter exposed by a native notification host. */
export function setNotificationIdentityNativeAdapter(
  adapter: NotificationIdentityNativeAdapter | null,
): void {
  installedNativeAdapter = adapter;
}

function dispatchNotificationIdentityReset(
  payload: ResetNotificationIdentitiesPayload,
): boolean {
  const accepted = resetNotificationIdentitySnapshots(payload);
  if (accepted) {
    invokeNativeIdentityAdapter("resetIdentities", payload);
  }
  return accepted;
}

function resetPublicationScope(scopeId: string, force = false): void {
  const tracked = publicationScopes.delete(scopeId);
  if (!tracked && !force) {
    return;
  }
  dispatchNotificationIdentityReset({
    scopeId,
    scopeEpoch: nextPublicationEpoch(
      scopeGenerationGuards.get(scopeId)?.latestEpoch,
    ),
  });
}

function ensurePublicationScope(scopeId: string): PublicationScope {
  const existing = publicationScopes.get(scopeId);
  if (existing) {
    publicationScopes.delete(scopeId);
    publicationScopes.set(scopeId, existing);
    return existing;
  }
  while (publicationScopes.size >= PUBLICATION_SCOPE_LIMIT) {
    const oldestScopeId = publicationScopes.keys().next().value as
      | string
      | undefined;
    if (!oldestScopeId) {
      break;
    }
    resetPublicationScope(oldestScopeId);
  }
  const scope = {
    scopeEpoch: nextPublicationEpoch(
      scopeGenerationGuards.get(scopeId)?.latestEpoch,
    ),
    revisions: new Map<string, { revision: number; active: boolean }>(),
  };
  publicationScopes.set(scopeId, scope);
  return scope;
}

function nextIdentityRevision(
  identity: NotificationIdentity,
): NotificationIdentityPublication {
  let scope = ensurePublicationScope(identity.scopeId);
  const key = notificationIdentityKey(identity);
  if (
    !scope.revisions.has(key) &&
    scope.revisions.size >= PUBLICATION_IDENTITY_LIMIT
  ) {
    resetPublicationScope(identity.scopeId);
    scope = ensurePublicationScope(identity.scopeId);
  }
  const identityRevision = (scope.revisions.get(key)?.revision ?? -1) + 1;
  scope.revisions.delete(key);
  scope.revisions.set(key, { revision: identityRevision, active: true });
  return {
    identity: { ...identity },
    scopeEpoch: scope.scopeEpoch,
    identityRevision,
  };
}

/** Claim the generation that subsequent asynchronous preparation must use. */
export function beginNotificationIdentityPublication(
  identity: NotificationIdentity,
): NotificationIdentityPublication {
  return nextIdentityRevision(identity);
}

export function isNotificationIdentityPublicationCurrent(
  publication: NotificationIdentityPublication,
): boolean {
  const scope = publicationScopes.get(publication.identity.scopeId);
  const revision = scope?.revisions.get(
    notificationIdentityKey(publication.identity),
  );
  return (
    scope?.scopeEpoch === publication.scopeEpoch &&
    revision?.active === true &&
    revision.revision === publication.identityRevision
  );
}

/** Publish locally first, then best-effort to an optional native memory sink. */
export function publishPreparedNotificationIdentity(
  publication: NotificationIdentityPublication,
  prepared: Pick<
    PrepareNotificationIdentityPayload,
    "name" | "nameProvenance" | "avatar"
  >,
): boolean {
  if (!isNotificationIdentityPublicationCurrent(publication)) {
    return false;
  }
  const payload: PrepareNotificationIdentityPayload = {
    ...publication,
    ...prepared,
  };
  const accepted = publishNotificationIdentitySnapshot(payload);
  if (accepted) {
    invokeNativeIdentityAdapter("prepareIdentity", payload);
  }
  return accepted;
}

/** Invalidate one exact assistant without disturbing siblings in its scope. */
export function resetPreparedNotificationIdentity(
  publication: NotificationIdentityPublication,
): boolean {
  if (!isNotificationIdentityPublicationCurrent(publication)) {
    return false;
  }
  return resetPreparedNotificationIdentityByKey(
    publication.identity.scopeId,
    publication.identity.assistantId,
  );
}

/** Invalidate one scoped assistant while preserving its stale-work floor. */
export function resetPreparedNotificationIdentityByKey(
  scopeId: string,
  assistantId: string,
): boolean {
  const normalizedScopeId = boundedIdentityPart(scopeId);
  const normalizedAssistantId = boundedIdentityPart(assistantId);
  if (!normalizedScopeId || !normalizedAssistantId) {
    return false;
  }
  const key = notificationIdentityKey({
    scopeId: normalizedScopeId,
    assistantId: normalizedAssistantId,
  });
  const publicationScope = publicationScopes.get(normalizedScopeId);
  const publicationRevision = publicationScope?.revisions.get(key);
  const snapshot = snapshots.get(key);
  const guard = identityGenerationGuards.get(key);
  if (!publicationRevision && !snapshot && !guard) {
    return false;
  }
  if (publicationRevision && !publicationRevision.active && !snapshot) {
    return true;
  }
  const scopeEpoch =
    publicationScope?.scopeEpoch ??
    scopeGenerationGuards.get(normalizedScopeId)?.latestEpoch ??
    0;
  const identityRevision =
    Math.max(
      publicationRevision?.revision ?? -1,
      snapshot?.scopeEpoch === scopeEpoch ? snapshot.identityRevision : -1,
      guard?.scopeEpoch === scopeEpoch ? guard.identityRevision : -1,
    ) + 1;
  if (publicationScope && publicationRevision) {
    publicationScope.revisions.delete(key);
    publicationScope.revisions.set(key, {
      revision: identityRevision,
      active: false,
    });
  }
  return dispatchNotificationIdentityReset({
    scopeId: normalizedScopeId,
    assistantId: normalizedAssistantId,
    scopeEpoch,
    identityRevision,
  });
}

function parseNotificationIdentityKey(
  key: string,
): NotificationIdentityOwner | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string"
    ) {
      return null;
    }
    return { scopeId: parsed[0], assistantId: parsed[1] };
  } catch {
    return null;
  }
}

/** Reset prepared identities no longer present in one resolved scope. */
export function reconcilePreparedNotificationIdentities(
  scopeId: string,
  retainedAssistantIds: readonly string[],
): number {
  const normalizedScopeId = boundedIdentityPart(scopeId);
  if (!normalizedScopeId) {
    return 0;
  }
  const shouldRetain = (assistantId: string): boolean =>
    retainedAssistantIds.some(
      (candidate) => boundedIdentityPart(candidate) === assistantId,
    );
  const candidates = new Set<string>();
  for (const snapshot of snapshots.values()) {
    if (
      snapshot.identity.scopeId === normalizedScopeId &&
      !shouldRetain(snapshot.identity.assistantId)
    ) {
      candidates.add(snapshot.identity.assistantId);
    }
  }
  const publicationScope = publicationScopes.get(normalizedScopeId);
  if (publicationScope) {
    for (const [key, revision] of publicationScope.revisions) {
      if (!revision.active) {
        continue;
      }
      const identity = parseNotificationIdentityKey(key);
      if (
        identity?.scopeId === normalizedScopeId &&
        !shouldRetain(identity.assistantId)
      ) {
        candidates.add(identity.assistantId);
      }
    }
  }
  let resetCount = 0;
  for (const assistantId of candidates) {
    if (
      resetPreparedNotificationIdentityByKey(normalizedScopeId, assistantId)
    ) {
      resetCount += 1;
    }
  }
  return resetCount;
}

/** Reset prepared identities absent from the complete resolved owner list. */
export function reconcilePreparedNotificationIdentityOwners(
  retainedOwners: readonly NotificationIdentityOwner[],
): number {
  const shouldRetain = (owner: NotificationIdentityOwner): boolean =>
    retainedOwners.some(
      (candidate) =>
        boundedIdentityPart(candidate.scopeId) === owner.scopeId &&
        boundedIdentityPart(candidate.assistantId) === owner.assistantId,
    );
  const candidates = new Map<string, NotificationIdentityOwner>();
  const resetScopes = new Set<string>();
  const trackedScopeIds = new Set(publicationScopes.keys());
  for (const snapshot of snapshots.values()) {
    trackedScopeIds.add(snapshot.identity.scopeId);
  }
  for (const scopeId of trackedScopeIds) {
    const hasRetainedOwner = retainedOwners.some(
      (candidate) => boundedIdentityPart(candidate.scopeId) === scopeId,
    );
    if (!hasRetainedOwner) {
      resetScopes.add(scopeId);
    }
  }
  let resetCount = 0;
  for (const scopeId of resetScopes) {
    resetPreparedNotificationScope(scopeId);
    resetCount += 1;
  }
  for (const snapshot of snapshots.values()) {
    const owner = {
      scopeId: snapshot.identity.scopeId,
      assistantId: snapshot.identity.assistantId,
    };
    if (!resetScopes.has(owner.scopeId) && !shouldRetain(owner)) {
      candidates.set(notificationIdentityKey(owner), owner);
    }
  }
  for (const scope of publicationScopes.values()) {
    for (const [key, revision] of scope.revisions) {
      if (!revision.active) {
        continue;
      }
      const owner = parseNotificationIdentityKey(key);
      if (
        owner &&
        !resetScopes.has(owner.scopeId) &&
        !shouldRetain(owner)
      ) {
        candidates.set(key, owner);
      }
    }
  }
  for (const owner of candidates.values()) {
    if (resetPreparedNotificationIdentityByKey(owner.scopeId, owner.assistantId)) {
      resetCount += 1;
    }
  }
  return resetCount;
}

/**
 * Invalidate pending work while retaining an already verified snapshot for
 * late notifications from an assistant that is no longer active.
 */
export function supersedePreparedNotificationIdentity(
  publication: NotificationIdentityPublication,
): boolean {
  if (!isNotificationIdentityPublicationCurrent(publication)) {
    return false;
  }
  const retained = getNotificationIdentitySnapshot(publication.identity);
  if (!resetPreparedNotificationIdentity(publication)) {
    return false;
  }
  if (!retained) {
    return true;
  }
  const replacement = beginNotificationIdentityPublication(
    publication.identity,
  );
  return publishPreparedNotificationIdentity(replacement, {
    ...(retained.name && retained.nameProvenance
      ? {
          name: retained.name,
          nameProvenance: retained.nameProvenance,
        }
      : {}),
    ...(retained.avatar ? { avatar: retained.avatar } : {}),
  });
}

/** Invalidate and retire one connection/account scope. */
export function resetPreparedNotificationScope(scopeId: string): void {
  const hasSnapshot = Array.from(snapshots.values()).some(
    (snapshot) => snapshot.identity.scopeId === scopeId,
  );
  resetPublicationScope(scopeId, hasSnapshot);
}

/** Drop all user-owned notification identity memory on a session boundary. */
export function resetNotificationIdentitySession(): void {
  const scopeIds = new Set(publicationScopes.keys());
  for (const snapshot of snapshots.values()) {
    scopeIds.add(snapshot.identity.scopeId);
  }
  clearNotificationAvatar();
  if (scopeIds.size === 0) {
    return;
  }
  for (const scopeId of scopeIds) {
    resetPublicationScope(scopeId, true);
  }
  publicationSessionGeneration += 1;
}

export function getNotificationIdentitySessionGeneration(): number {
  return publicationSessionGeneration;
}

/** Test/process teardown only. Runtime invalidation uses the guarded reset API. */
export function __clearNotificationIdentitySnapshotsForTests(): void {
  snapshots.clear();
  scopeGenerationGuards.clear();
  identityGenerationGuards.clear();
  publicationScopes.clear();
  publicationEpoch = 0;
  publicationSessionGeneration = 0;
  installedNativeAdapter = null;
  clearNotificationAvatar();
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
