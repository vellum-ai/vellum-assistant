import { useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "@/runtime/is-electron";
import {
  beginNotificationIdentityPublication,
  clearNotificationAvatar,
  createNotificationIdentity,
  getNotificationIdentitySessionGeneration,
  isNotificationIdentityPublicationCurrent,
  publishPreparedNotificationIdentity,
  resolveNotificationIdentityScope,
  resetPreparedNotificationIdentity,
  resetPreparedNotificationScope,
  sameNotificationIdentity,
  setNotificationAvatar,
  sha256Hex,
  supersedePreparedNotificationIdentity,
  type NotificationIdentityOwner,
  type NotificationIdentityPublication,
  type NotificationIdentityScopeInput,
} from "@/runtime/notification-avatar";
import { isPopoutWindowLifetime } from "@/runtime/popout-window";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import type {
  AvatarImageMeta,
  CharacterComponents,
  CharacterTraits,
} from "@/types/avatar";
import { rasterizeNotificationAvatar } from "@/utils/avatar-raster";
import { resolveAvatarRender } from "@/utils/avatar-render";
import { encodeBase64Bytes } from "@/utils/base64";
import {
  NOTIFICATION_AVATAR_MAX_LOCAL_BYTES,
  NOTIFICATION_AVATAR_SIZE,
  NOTIFICATION_AVATAR_SPEC_VERSION,
} from "@vellumai/avatar-manifest/notification-avatar";
import type { NotificationAvatar } from "@vellumai/ipc-contract";

export type NotificationAvatarScope = NotificationIdentityScopeInput;

export interface NotificationAvatarSyncOptions {
  scopeId: string | null;
  platformAssistantId?: string | null;
  assistantName?: string | null;
  assistantNameOwner?: NotificationIdentityOwner | null;
  avatarOwner?: NotificationIdentityOwner | null;
  /** True only after the avatar query has produced a conclusive answer. */
  avatarReady?: boolean;
}

interface CachedPreparedAvatar {
  identityKey: string;
  pictureKey: string;
  png: Uint8Array<ArrayBuffer>;
  avatar: NotificationAvatar;
}

/** Opaque deterministic account or normalized connection-origin scope. */
export function resolveNotificationAvatarScope(
  scope: NotificationAvatarScope | null,
): string | null {
  return resolveNotificationIdentityScope(scope);
}

function ownerMatches(
  owner: NotificationIdentityOwner | null | undefined,
  scopeId: string | null,
  assistantId: string | null,
): boolean {
  return Boolean(
    owner &&
      scopeId &&
      assistantId &&
      owner.scopeId === scopeId &&
      owner.assistantId === assistantId,
  );
}

/**
 * Prepare the active assistant identity for local notification consumers.
 * The scoped snapshot path runs on every renderer surface when either sender
 * feature needs it. The legacy singleton remains main-Electron-only because
 * it also feeds the existing dock/tray notification path.
 */
export function useNotificationAvatarSync(
  assistantId: string | null,
  customImageUrl: string | null,
  imageMeta: AvatarImageMeta | null,
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
  accentHex: string | null,
  options?: NotificationAvatarSyncOptions,
): void {
  const pushAvatarSender = useClientFeatureFlagStore.use.pushAvatarSender();
  const localNotificationAvatar =
    useClientFeatureFlagStore.use.localNotificationAvatar();
  const prepareEnabled = pushAvatarSender || localNotificationAvatar;
  const legacyEnabled =
    pushAvatarSender && isElectron() && !isPopoutWindowLifetime();
  const scopeId = options
    ? options.scopeId
    : resolveNotificationIdentityScope({
        kind: "connection",
        url:
          typeof globalThis.location === "undefined"
            ? null
            : globalThis.location.href,
      });
  const identity = useMemo(
    () =>
      assistantId && scopeId
        ? createNotificationIdentity(
            scopeId,
            assistantId,
            options?.platformAssistantId,
          )
        : null,
    [assistantId, options?.platformAssistantId, scopeId],
  );
  const identityKey = identity
    ? JSON.stringify([
        identity.scopeId,
        identity.assistantId,
        identity.nativeSenderId,
      ])
    : null;
  const avatarOwnerMatches = options
    ? ownerMatches(options.avatarOwner, scopeId, assistantId)
    : true;
  const assistantNameOwnerMatches = options
    ? ownerMatches(options.assistantNameOwner, scopeId, assistantId)
    : true;
  const assistantName = assistantNameOwnerMatches
    ? options?.assistantName?.trim() || null
    : null;
  const sessionGeneration = getNotificationIdentitySessionGeneration();
  const avatarReady = avatarOwnerMatches
    ? (options?.avatarReady ?? true)
    : false;
  const render = resolveAvatarRender(
    avatarOwnerMatches ? customImageUrl : null,
    avatarOwnerMatches ? components : null,
    avatarOwnerMatches ? traits : null,
    NOTIFICATION_AVATAR_SIZE,
  );
  const renderSource =
    render.kind === "character"
      ? render.dataUri
      : render.kind === "image"
        ? render.url
        : null;
  const imageId = avatarOwnerMatches && imageMeta
    ? JSON.stringify([imageMeta.updatedAt, imageMeta.etag])
    : null;
  const picture =
    render.kind === "none"
      ? avatarReady
        ? "none"
        : "pending"
      : render.kind === "image" && imageId
        ? imageId
        : renderSource;
  const pictureKey = JSON.stringify([
    NOTIFICATION_AVATAR_SPEC_VERSION,
    avatarOwnerMatches ? accentHex : null,
    picture,
  ]);
  const updateKey = JSON.stringify([
    sessionGeneration,
    identityKey,
    assistantName,
    pictureKey,
    prepareEnabled,
    legacyEnabled,
  ]);

  const currentPublication =
    useRef<NotificationIdentityPublication | null>(null);
  const lastUpdateKey = useRef<string | null>(null);
  const inFlightPictureKey = useRef<string | null>(null);
  const cachedAvatar = useRef<CachedPreparedAvatar | null>(null);
  const redrawnKey = useRef<string | null>(null);
  const [redraws, setRedraws] = useState(0);

  useEffect(
    () => () => {
      const publication = currentPublication.current;
      currentPublication.current = null;
      if (publication) {
        resetPreparedNotificationIdentity(publication);
      }
      clearNotificationAvatar();
    },
    [],
  );

  useEffect(() => {
    const previous = currentPublication.current;
    if (!prepareEnabled || !identity) {
      currentPublication.current = null;
      lastUpdateKey.current = null;
      inFlightPictureKey.current = null;
      cachedAvatar.current = null;
      if (previous) {
        resetPreparedNotificationIdentity(previous);
      }
      clearNotificationAvatar();
      return;
    }

    if (previous && !sameNotificationIdentity(previous.identity, identity)) {
      currentPublication.current = null;
      if (previous.identity.scopeId === identity.scopeId) {
        if (previous.identity.assistantId === identity.assistantId) {
          resetPreparedNotificationIdentity(previous);
        } else {
          supersedePreparedNotificationIdentity(previous);
        }
      } else {
        resetPreparedNotificationScope(previous.identity.scopeId);
      }
      lastUpdateKey.current = null;
      inFlightPictureKey.current = null;
      cachedAvatar.current = null;
      clearNotificationAvatar();
    }

    if (
      lastUpdateKey.current === updateKey &&
      currentPublication.current &&
      isNotificationIdentityPublicationCurrent(currentPublication.current)
    ) {
      const cached = cachedAvatar.current;
      if (
        legacyEnabled &&
        cached?.identityKey === identityKey &&
        cached.pictureKey === pictureKey
      ) {
        setNotificationAvatar(
          identity.assistantId,
          cached.png,
          cached.avatar.avatarHash,
        );
      } else if (!legacyEnabled) {
        clearNotificationAvatar();
      }
      return;
    }
    lastUpdateKey.current = updateKey;
    inFlightPictureKey.current = null;

    let publication = beginNotificationIdentityPublication(identity);
    currentPublication.current = publication;
    const cached = cachedAvatar.current;
    const preparedName = assistantName
      ? { name: assistantName, nameProvenance: "identity-store" as const }
      : {};

    if (render.kind === "none" && avatarReady) {
      resetPreparedNotificationIdentity(publication);
      publication = beginNotificationIdentityPublication(identity);
      currentPublication.current = publication;
      cachedAvatar.current = null;
      inFlightPictureKey.current = null;
      clearNotificationAvatar();
      if (assistantName) {
        publishPreparedNotificationIdentity(publication, preparedName);
      }
      return;
    }

    const cachedForPicture =
      cached?.identityKey === identityKey && cached.pictureKey === pictureKey
        ? cached
        : null;
    publishPreparedNotificationIdentity(publication, {
      ...preparedName,
      ...(cachedForPicture ? { avatar: cachedForPicture.avatar } : {}),
    });

    if (cachedForPicture) {
      inFlightPictureKey.current = null;
      if (legacyEnabled) {
        setNotificationAvatar(
          identity.assistantId,
          cachedForPicture.png,
          cachedForPicture.avatar.avatarHash,
        );
      } else {
        clearNotificationAvatar();
      }
      return;
    }

    if (!renderSource || inFlightPictureKey.current === pictureKey) {
      if (!legacyEnabled) {
        clearNotificationAvatar();
      }
      return;
    }
    inFlightPictureKey.current = pictureKey;

    const giveUp = (): void => {
      if (currentPublication.current !== publication) {
        return;
      }
      inFlightPictureKey.current = null;
      lastUpdateKey.current = null;
      if (redrawnKey.current === pictureKey) {
        return;
      }
      redrawnKey.current = pictureKey;
      setRedraws((count) => count + 1);
    };

    void rasterizeNotificationAvatar(renderSource, accentHex)
      .then(async (png) => {
        if (currentPublication.current !== publication) {
          return;
        }
        if (!png) {
          giveUp();
          return;
        }
        if (png.byteLength > NOTIFICATION_AVATAR_MAX_LOCAL_BYTES) {
          warnOversized(png.byteLength);
          resetPreparedNotificationIdentity(publication);
          const withoutAvatar = beginNotificationIdentityPublication(identity);
          currentPublication.current = withoutAvatar;
          cachedAvatar.current = null;
          inFlightPictureKey.current = null;
          clearNotificationAvatar();
          if (assistantName) {
            publishPreparedNotificationIdentity(withoutAvatar, preparedName);
          }
          return;
        }
        const hash = await sha256Hex(png);
        if (currentPublication.current !== publication) {
          return;
        }
        const avatar = {
          avatarBase64: encodeBase64Bytes(png),
          avatarHash: hash,
        };
        if (!publishPreparedNotificationIdentity(publication, { avatar })) {
          return;
        }
        inFlightPictureKey.current = null;
        cachedAvatar.current = {
          identityKey: identityKey!,
          pictureKey,
          png,
          avatar,
        };
        if (legacyEnabled) {
          setNotificationAvatar(identity.assistantId, png, hash);
        }
      })
      .catch(giveUp);
  }, [
    prepareEnabled,
    legacyEnabled,
    identity,
    identityKey,
    assistantName,
    sessionGeneration,
    pictureKey,
    render.kind,
    renderSource,
    avatarReady,
    accentHex,
    customImageUrl,
    components,
    traits,
    avatarOwnerMatches,
    redraws,
    updateKey,
  ]);
}

let warnedOversized = false;

function warnOversized(bytes: number): void {
  if (warnedOversized) {
    return;
  }
  warnedOversized = true;
  console.warn(
    "notification-avatar: render exceeds the local cap; posting without a sender",
    { bytes, cap: NOTIFICATION_AVATAR_MAX_LOCAL_BYTES },
  );
}
