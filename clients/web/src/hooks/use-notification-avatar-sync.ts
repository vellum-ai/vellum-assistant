import { useEffect, useRef } from "react";

import { isElectron } from "@/runtime/is-electron";
import {
  clearNotificationAvatar,
  setNotificationAvatar,
  sha256Hex,
} from "@/runtime/notification-avatar";
import { isPopoutWindowLifetime } from "@/runtime/popout-window";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { rasterizeNotificationAvatar } from "@/utils/avatar-raster";
import { resolveAvatarRender } from "@/utils/avatar-render";
import {
  NOTIFICATION_AVATAR_MAX_LOCAL_BYTES,
  NOTIFICATION_AVATAR_SIZE,
  NOTIFICATION_AVATAR_SPEC_VERSION,
} from "@vellumai/avatar-manifest/notification-avatar";

/**
 * Composite the assistant's avatar onto its accent disc and hold the result for
 * the desktop notifications that post it as the sender's icon.
 *
 * Shaped like `useElectronIconSync` and mounted beside it, off the same avatar
 * query, so the notification icon can never show a different assistant than the
 * one on screen. The canvas work is gated behind the main Electron window and
 * `push-avatar-sender`: no other host reads the holder, a pop-out thread window
 * would publish over the window whose notifications these are, and while the
 * flag is off the holder stays empty so the IPC payload carries no `sender`
 * field.
 *
 * What a run stores is stamped with the assistant it was drawn for, and the
 * holder outlives this effect, so a flag turned off, an assistant with no
 * avatar, a failed rasterization and an unmount all have to take back what an
 * earlier run put there.
 *
 * A run is keyed on the picture rather than on the effect firing. The avatar
 * query re-reads without structural sharing, so `components` and `traits`
 * arrive as fresh objects on every refetch and this effect re-runs for a
 * picture that has not changed; emptying the holder each time would leave any
 * notification posted across the rasterize-and-hash gap with no avatar and no
 * sender name. The key is the arbiter of the gap in both directions: an equal
 * key does nothing at all, and a render whose key has since been replaced never
 * writes what it drew.
 */
export function useNotificationAvatarSync(
  assistantId: string | null,
  customImageUrl: string | null,
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
  accentHex: string | null,
): void {
  const enabled = useClientFeatureFlagStore.use.pushAvatarSender();
  const heldKey = useRef<string | null>(null);

  useEffect(
    () => () => {
      heldKey.current = null;
      clearNotificationAvatar();
    },
    [],
  );

  useEffect(() => {
    const release = (): void => {
      heldKey.current = null;
      clearNotificationAvatar();
    };

    if (!isElectron() || isPopoutWindowLifetime() || !enabled || !assistantId) {
      release();
      return;
    }

    const render = resolveAvatarRender(
      customImageUrl,
      components,
      traits,
      NOTIFICATION_AVATAR_SIZE,
    );
    if (render.kind === "none") {
      release();
      return;
    }

    const src = render.kind === "character" ? render.dataUri : render.url;
    const key = `${assistantId}|${NOTIFICATION_AVATAR_SPEC_VERSION}|${accentHex ?? ""}|${src}`;
    if (key === heldKey.current) {
      return;
    }
    heldKey.current = key;
    clearNotificationAvatar();

    void rasterizeNotificationAvatar(src, accentHex)
      .then(async (png) => {
        if (heldKey.current !== key || !png) {
          return;
        }
        if (png.byteLength > NOTIFICATION_AVATAR_MAX_LOCAL_BYTES) {
          warnOversized(png.byteLength);
          return;
        }
        const hash = await sha256Hex(png);
        if (heldKey.current === key) {
          setNotificationAvatar(assistantId, png, hash);
        }
      })
      .catch(() => {
        if (heldKey.current === key) {
          clearNotificationAvatar();
        }
      });
  }, [enabled, assistantId, customImageUrl, components, traits, accentHex]);
}

let warnedOversized = false;

/**
 * The host caches every disc it is handed on disk, so one too heavy to carry
 * is dropped rather than sent. Reported once: the same avatar redraws on every
 * refetch, and a per-render line would say the same thing forever.
 */
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
