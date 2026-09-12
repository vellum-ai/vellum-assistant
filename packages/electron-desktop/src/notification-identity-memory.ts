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
const PUBLISHER_SOURCE_LIMIT = SCOPE_GENERATION_LIMIT;
const RETIRED_PUBLISHER_SESSION_LIMIT = 16;
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

interface PublisherIdentityGeneration {
  localRevision: number;
  nativeRevision: number;
  tombstone: boolean;
}

interface PublisherScopeGeneration {
  localEpoch: number;
  nativeEpoch: number;
  sealed: boolean;
  identities: Map<string, PublisherIdentityGeneration>;
}

interface PublisherSourceState {
  activeSessionId: string;
  retiredSessionIds: Set<string>;
  scopes: Map<string, PublisherScopeGeneration>;
}

const identities = new Map<string, PreparedNotificationIdentity>();
const scopeGenerationGuards = new Map<string, ScopeGenerationGuard>();
const identityGenerationGuards = new Map<
  string,
  IdentityGenerationGuard
>();
const publisherSources = new Map<string, PublisherSourceState>();

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

const nextSafeGeneration = (current: number): number | null =>
  current < Number.MAX_SAFE_INTEGER ? current + 1 : null;

const activatePublisherSession = (
  sourceId: string,
  sessionId: string,
): PublisherSourceState | null => {
  const normalizedSourceId = boundedIdentityPart(sourceId);
  const normalizedSessionId = boundedIdentityPart(sessionId);
  if (!normalizedSourceId || !normalizedSessionId) {
    return null;
  }
  const existing = publisherSources.get(normalizedSourceId);
  if (!existing) {
    if (publisherSources.size >= PUBLISHER_SOURCE_LIMIT) {
      return null;
    }
    const created = {
      activeSessionId: normalizedSessionId,
      retiredSessionIds: new Set<string>(),
      scopes: new Map<string, PublisherScopeGeneration>(),
    };
    publisherSources.set(normalizedSourceId, created);
    return created;
  }
  if (existing.activeSessionId === normalizedSessionId) {
    return existing;
  }
  if (existing.retiredSessionIds.has(normalizedSessionId)) {
    return null;
  }
  existing.retiredSessionIds.add(existing.activeSessionId);
  while (
    existing.retiredSessionIds.size > RETIRED_PUBLISHER_SESSION_LIMIT
  ) {
    const oldest = existing.retiredSessionIds.values().next().value as
      | string
      | undefined;
    if (!oldest) {
      return null;
    }
    existing.retiredSessionIds.delete(oldest);
  }
  existing.activeSessionId = normalizedSessionId;
  existing.scopes.clear();
  return existing;
};

const nativeScopeEpochForTarget = (scopeId: string): number | null => {
  const scope = scopeGenerationGuards.get(scopeId);
  if (!scope) {
    return 0;
  }
  if (
    scope.sealedEpoch === undefined ||
    scope.latestEpoch > scope.sealedEpoch
  ) {
    return scope.latestEpoch;
  }
  return nextSafeGeneration(scope.latestEpoch);
};

const nextNativeScopeEpoch = (scopeId: string): number | null =>
  nextSafeGeneration(scopeGenerationGuards.get(scopeId)?.latestEpoch ?? -1);

const nativeIdentityRevision = (
  scopeId: string,
  assistantId: string,
  scopeEpoch: number,
): number => {
  const key = identityKey({ scopeId, assistantId });
  const generation = identityGenerationGuards.get(key);
  const prepared = identities.get(key);
  return Math.max(
    generation?.scopeEpoch === scopeEpoch ? generation.identityRevision : -1,
    prepared?.scopeEpoch === scopeEpoch ? prepared.identityRevision : -1,
  );
};

const publisherState = (
  sourceId: string | undefined,
  sessionId: string | undefined,
): PublisherSourceState | null | undefined => {
  if (!sessionId) {
    return sourceId && publisherSources.has(sourceId) ? null : undefined;
  }
  if (!sourceId) {
    return null;
  }
  const source = publisherSources.get(sourceId);
  return source?.activeSessionId === sessionId ? source : null;
};

const publisherTargetGeneration = (
  source: PublisherSourceState,
  scopeId: string,
  assistantId: string,
  localEpoch: number,
  localRevision: number,
  tombstone: boolean,
): { scopeEpoch: number; identityRevision: number } | null => {
  let scope = source.scopes.get(scopeId);
  if (!scope || localEpoch > scope.localEpoch) {
    const createsScope = !scope;
    const nativeEpoch = scope
      ? nextNativeScopeEpoch(scopeId)
      : nativeScopeEpochForTarget(scopeId);
    if (
      nativeEpoch === null ||
      (createsScope && source.scopes.size >= SCOPE_GENERATION_LIMIT)
    ) {
      return null;
    }
    scope = {
      localEpoch,
      nativeEpoch,
      sealed: false,
      identities: new Map<string, PublisherIdentityGeneration>(),
    };
    source.scopes.set(scopeId, scope);
  } else if (localEpoch < scope.localEpoch || scope.sealed) {
    return null;
  }

  const mapped = scope.identities.get(assistantId);
  if (mapped && localRevision < mapped.localRevision) {
    return null;
  }
  if (mapped && localRevision === mapped.localRevision) {
    if (!tombstone && mapped.tombstone) {
      return null;
    }
    if (tombstone) {
      mapped.tombstone = true;
    }
    return {
      scopeEpoch: scope.nativeEpoch,
      identityRevision: mapped.nativeRevision,
    };
  }
  if (
    !mapped &&
    scope.identities.size >= IDENTITY_GENERATION_LIMIT
  ) {
    return null;
  }
  const nativeRevision = nextSafeGeneration(
    nativeIdentityRevision(scopeId, assistantId, scope.nativeEpoch),
  );
  if (nativeRevision === null) {
    return null;
  }
  scope.identities.set(assistantId, {
    localRevision,
    nativeRevision,
    tombstone,
  });
  return { scopeEpoch: scope.nativeEpoch, identityRevision: nativeRevision };
};

const publisherScopeResetGeneration = (
  source: PublisherSourceState,
  scopeId: string,
  localEpoch: number,
): number | null => {
  const mapped = source.scopes.get(scopeId);
  if (mapped && localEpoch < mapped.localEpoch) {
    return null;
  }
  if (mapped && localEpoch === mapped.localEpoch && mapped.sealed) {
    return mapped.nativeEpoch;
  }
  if (!mapped && source.scopes.size >= SCOPE_GENERATION_LIMIT) {
    return null;
  }
  const nativeEpoch = nextNativeScopeEpoch(scopeId);
  if (nativeEpoch === null) {
    return null;
  }
  source.scopes.set(scopeId, {
    localEpoch,
    nativeEpoch,
    sealed: true,
    identities: new Map<string, PublisherIdentityGeneration>(),
  });
  return nativeEpoch;
};

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
  publisherSourceId?: string,
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
  const source = publisherState(
    publisherSourceId,
    payload.publisherSessionId,
  );
  if (source === null) {
    return false;
  }
  const mappedGeneration = source
    ? publisherTargetGeneration(
        source,
        identity.scopeId,
        identity.assistantId,
        payload.scopeEpoch,
        payload.identityRevision,
        false,
      )
    : {
        scopeEpoch: payload.scopeEpoch,
        identityRevision: payload.identityRevision,
      };
  if (!mappedGeneration) {
    return false;
  }
  payload = { ...payload, ...mappedGeneration };
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
  publisherSourceId?: string,
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

  const source = publisherState(
    publisherSourceId,
    payload.publisherSessionId,
  );
  if (source === null) {
    return false;
  }
  if (source) {
    if (assistantId) {
      const mappedGeneration = publisherTargetGeneration(
        source,
        scopeId,
        assistantId,
        payload.scopeEpoch,
        payload.identityRevision ?? 0,
        true,
      );
      if (!mappedGeneration) {
        return false;
      }
      payload = { ...payload, ...mappedGeneration };
    } else {
      const scopeEpoch = publisherScopeResetGeneration(
        source,
        scopeId,
        payload.scopeEpoch,
      );
      if (scopeEpoch === null) {
        return false;
      }
      payload = { ...payload, scopeEpoch };
    }
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

export const registerNotificationIdentityPublisherSource = (
  sourceId: string,
  sessionId: string,
): boolean => activatePublisherSession(sourceId, sessionId) !== null;

export const forgetNotificationIdentityPublisherSource = (
  sourceId: string,
): void => {
  publisherSources.delete(sourceId);
};

/** Test-only full reset, including stale-work guards. */
export const __resetNotificationIdentityMemoryForTesting = (): void => {
  identities.clear();
  scopeGenerationGuards.clear();
  identityGenerationGuards.clear();
  publisherSources.clear();
};
