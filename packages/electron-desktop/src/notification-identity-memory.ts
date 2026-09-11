import { createHash } from "node:crypto";

import {
  NOTIFICATION_AVATAR_BASE64_MAX_CHARS,
  NOTIFICATION_AVATAR_HASH_PATTERN,
  NOTIFICATION_IDENTITY_MAX_CHARS,
  NOTIFICATION_SENDER_NAME_MAX_CHARS,
  VERIFIED_NOTIFICATION_NAME_PROVENANCES,
  type NotificationIdentity,
  type PrepareNotificationIdentityPayload,
  type ResetNotificationIdentitiesPayload,
  type VerifiedNotificationNameProvenance,
} from "@vellumai/ipc-contract";

export const NOTIFICATION_IDENTITY_MEMORY_LIMIT = 32;

const IDENTITY_GENERATION_LIMIT = NOTIFICATION_IDENTITY_MEMORY_LIMIT * 2;
const SCOPE_GENERATION_LIMIT = IDENTITY_GENERATION_LIMIT;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const OPAQUE_SCOPE_PATTERN = /^scope:v1:[a-f0-9]{64}$/;
const VERIFIED_NAME_PROVENANCES = new Set<VerifiedNotificationNameProvenance>(
  VERIFIED_NOTIFICATION_NAME_PROVENANCES,
);

export interface PreparedNotificationIdentity {
  identity: NotificationIdentity;
  scopeEpoch: number;
  identityRevision: number;
  name?: string;
  nameProvenance?: VerifiedNotificationNameProvenance;
  avatar?: {
    avatarPng: Buffer;
    avatarHash: string;
  };
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

const identities = new Map<string, PreparedNotificationIdentity>();
const scopeGenerationGuards = new Map<string, ScopeGenerationGuard>();
const identityGenerationGuards = new Map<
  string,
  IdentityGenerationGuard
>();

const identityKey = (
  identity: Pick<NotificationIdentity, "scopeId" | "assistantId">,
): string => JSON.stringify([identity.scopeId, identity.assistantId]);

const boundedIdentityPart = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed && trimmed.length <= NOTIFICATION_IDENTITY_MAX_CHARS
    ? trimmed
    : null;
};

/** Normalize and validate a full opaque identity at the native boundary. */
export const normalizeNotificationIdentity = (
  identity: NotificationIdentity,
): NotificationIdentity | null => {
  const scopeId = boundedIdentityPart(identity.scopeId);
  const assistantId = boundedIdentityPart(identity.assistantId);
  const nativeSenderId = boundedIdentityPart(identity.nativeSenderId);
  return scopeId &&
    OPAQUE_SCOPE_PATTERN.test(scopeId) &&
    assistantId &&
    nativeSenderId
    ? { scopeId, assistantId, nativeSenderId }
    : null;
};

const sameIdentity = (
  left: NotificationIdentity,
  right: NotificationIdentity,
): boolean =>
  left.scopeId === right.scopeId &&
  left.assistantId === right.assistantId &&
  left.nativeSenderId === right.nativeSenderId;

const normalizeName = (
  payload: PrepareNotificationIdentityPayload,
): { name: string; provenance: VerifiedNotificationNameProvenance } | null => {
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
};

const normalizeAvatar = (
  payload: PrepareNotificationIdentityPayload["avatar"],
): PreparedNotificationIdentity["avatar"] | null => {
  if (
    !payload ||
    payload.avatarBase64.length < 4 ||
    payload.avatarBase64.length > NOTIFICATION_AVATAR_BASE64_MAX_CHARS ||
    !BASE64_PATTERN.test(payload.avatarBase64) ||
    !NOTIFICATION_AVATAR_HASH_PATTERN.test(payload.avatarHash)
  ) {
    return null;
  }
  const avatarPng = Buffer.from(payload.avatarBase64, "base64");
  const digest = createHash("sha256").update(avatarPng).digest("hex");
  if (digest !== payload.avatarHash) {
    return null;
  }
  return { avatarPng, avatarHash: payload.avatarHash };
};

const validGeneration = (
  scopeEpoch: number,
  identityRevision: number,
): boolean =>
  Number.isSafeInteger(scopeEpoch) &&
  scopeEpoch >= 0 &&
  Number.isSafeInteger(identityRevision) &&
  identityRevision >= 0;

const setBounded = <Key, Value>(
  map: Map<Key, Value>,
  key: Key,
  value: Value,
  limit: number,
): void => {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value as Key | undefined;
    if (oldest === undefined) {
      return;
    }
    map.delete(oldest);
  }
};

const clearScopeIdentityState = (scopeId: string): void => {
  for (const [key, identity] of identities) {
    if (identity.identity.scopeId === scopeId) {
      identities.delete(key);
    }
  }
  for (const [key, guard] of identityGenerationGuards) {
    if (guard.scopeId === scopeId) {
      identityGenerationGuards.delete(key);
    }
  }
};

const sealScope = (scopeId: string): void => {
  const scope = scopeGenerationGuards.get(scopeId);
  if (!scope) {
    return;
  }
  clearScopeIdentityState(scopeId);
  scopeGenerationGuards.set(scopeId, {
    latestEpoch: scope.latestEpoch,
    sealedEpoch: Math.max(scope.sealedEpoch ?? -1, scope.latestEpoch),
  });
};

const updateScopeEpoch = (
  scopeId: string,
  scopeEpoch: number,
): { state: ScopeGenerationGuard; advanced: boolean } | null => {
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
};

const acceptScopeEpoch = (scopeId: string, scopeEpoch: number): boolean => {
  const update = updateScopeEpoch(scopeId, scopeEpoch);
  return Boolean(
    update &&
      (update.state.sealedEpoch === undefined ||
        scopeEpoch > update.state.sealedEpoch),
  );
};

const setIdentityGenerationGuard = (
  key: string,
  generation: IdentityGenerationGuard,
): boolean => {
  if (!identityGenerationGuards.has(key)) {
    while (identityGenerationGuards.size >= IDENTITY_GENERATION_LIMIT) {
      const oldest = identityGenerationGuards.values().next().value as
        | IdentityGenerationGuard
        | undefined;
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
};

/** Publish independently verified name and avatar fields for one exact owner. */
export const prepareNotificationIdentity = (
  payload: PrepareNotificationIdentityPayload,
): boolean => {
  const identity = normalizeNotificationIdentity(payload.identity);
  if (
    !identity ||
    !validGeneration(payload.scopeEpoch, payload.identityRevision)
  ) {
    return false;
  }
  const name = normalizeName(payload);
  const avatar = normalizeAvatar(payload.avatar);
  if (!name && !avatar) {
    return false;
  }
  if (!acceptScopeEpoch(identity.scopeId, payload.scopeEpoch)) {
    return false;
  }

  const key = identityKey(identity);
  const prior = identities.get(key);
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
    sameIdentity(prior.identity, identity);
  const next: PreparedNotificationIdentity = {
    identity,
    scopeEpoch: payload.scopeEpoch,
    identityRevision: payload.identityRevision,
    ...(canMerge && prior.name
      ? { name: prior.name, nameProvenance: prior.nameProvenance }
      : {}),
    ...(canMerge && prior.avatar
      ? {
          avatar: {
            avatarPng: Buffer.from(prior.avatar.avatarPng),
            avatarHash: prior.avatar.avatarHash,
          },
        }
      : {}),
    ...(name ? { name: name.name, nameProvenance: name.provenance } : {}),
    ...(avatar ? { avatar } : {}),
  };
  if (
    !setIdentityGenerationGuard(key, {
      scopeId: identity.scopeId,
      scopeEpoch: payload.scopeEpoch,
      identityRevision: payload.identityRevision,
    })
  ) {
    return false;
  }
  setBounded(identities, key, next, NOTIFICATION_IDENTITY_MEMORY_LIMIT);
  return true;
};

/** Read one exact prepared identity and refresh its bounded LRU position. */
export const getPreparedNotificationIdentity = (
  identity: NotificationIdentity,
): PreparedNotificationIdentity | null => {
  const normalized = normalizeNotificationIdentity(identity);
  if (!normalized) {
    return null;
  }
  const key = identityKey(normalized);
  const prepared = identities.get(key);
  if (!prepared || !sameIdentity(prepared.identity, normalized)) {
    return null;
  }
  const scope = scopeGenerationGuards.get(normalized.scopeId);
  if (scope && prepared.scopeEpoch < scope.latestEpoch) {
    identities.delete(key);
    return null;
  }
  const generation = identityGenerationGuards.get(key);
  if (generation) {
    setBounded(
      identityGenerationGuards,
      key,
      generation,
      IDENTITY_GENERATION_LIMIT,
    );
  }
  setBounded(identities, key, prepared, NOTIFICATION_IDENTITY_MEMORY_LIMIT);
  return {
    ...prepared,
    identity: { ...prepared.identity },
    ...(prepared.avatar
      ? {
          avatar: {
            avatarPng: Buffer.from(prepared.avatar.avatarPng),
            avatarHash: prepared.avatar.avatarHash,
          },
        }
      : {}),
  };
};

/** Reset one assistant or every assistant in an opaque scope. */
export const resetNotificationIdentities = (
  payload: ResetNotificationIdentitiesPayload,
): boolean => {
  const scopeId = boundedIdentityPart(payload.scopeId);
  const assistantId = payload.assistantId
    ? boundedIdentityPart(payload.assistantId)
    : null;
  if (
    !scopeId ||
    !OPAQUE_SCOPE_PATTERN.test(scopeId) ||
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
    const key = identityKey({ scopeId, assistantId });
    const priorGeneration = identityGenerationGuards.get(key);
    const priorIdentity = identities.get(key);
    const latestKnownRevision = Math.max(
      priorGeneration?.scopeEpoch === payload.scopeEpoch
        ? priorGeneration.identityRevision
        : -1,
      priorIdentity?.scopeEpoch === payload.scopeEpoch
        ? priorIdentity.identityRevision
        : -1,
    );
    if (
      payload.identityRevision !== undefined &&
      payload.identityRevision < latestKnownRevision
    ) {
      return false;
    }
    identities.delete(key);
    return setIdentityGenerationGuard(key, {
      scopeId,
      scopeEpoch: payload.scopeEpoch,
      identityRevision: Math.max(
        payload.identityRevision ?? -1,
        latestKnownRevision,
      ),
      revisionTombstone: true,
    });
  }

  clearScopeIdentityState(scopeId);
  if (!scopeUpdate.advanced) {
    scopeGenerationGuards.set(scopeId, {
      latestEpoch: payload.scopeEpoch,
      sealedEpoch: payload.scopeEpoch,
    });
  }
  return true;
};

/** Clear sign-out data and require a newer scope epoch before publication. */
export const clearNotificationIdentityMemory = (): void => {
  for (const scopeId of scopeGenerationGuards.keys()) {
    sealScope(scopeId);
  }
};

/** Test-only full reset, including stale-work guards. */
export const __resetNotificationIdentityMemoryForTesting = (): void => {
  identities.clear();
  scopeGenerationGuards.clear();
  identityGenerationGuards.clear();
};
