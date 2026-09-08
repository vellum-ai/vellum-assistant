import { useEffect } from "react";

import { isElectron } from "@/runtime/is-electron";
import {
  clearNotificationAvatar,
  setNotificationAvatar,
  sha256Hex,
} from "@/runtime/notification-avatar";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { rasterizeNotificationAvatar } from "@/utils/avatar-raster";
import { resolveAvatarRender } from "@/utils/avatar-render";
import { NOTIFICATION_AVATAR_SIZE } from "@vellumai/avatar-manifest/notification-avatar";

/**
 * Composite the assistant's avatar onto its accent disc and hold the result for
 * the desktop notifications that post it as the sender's icon.
 *
 * Shaped like `useElectronIconSync` and mounted beside it, off the same avatar
 * query, so the notification icon can never show a different assistant than the
 * one on screen. The canvas work is gated behind Electron and
 * `push-avatar-sender`: no other host reads the holder, and while the flag is
 * off the holder stays empty so the IPC payload carries no `sender` field.
 *
 * Every run starts by emptying the holder, and what it stores is stamped with
 * the assistant it was drawn for. The holder outlives this effect, so a flag
 * turned off, an assistant with no avatar, or a failed rasterization all have
 * to take back what an earlier run put there; and a replacement render must not
 * keep serving the old picture across the rasterize-and-hash gap, which is the
 * window an assistant switch lands in.
 */
export function useNotificationAvatarSync(
  assistantId: string | null,
  customImageUrl: string | null,
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
  accentHex: string | null,
): void {
  const enabled = useClientFeatureFlagStore.use.pushAvatarSender();

  useEffect(() => {
    clearNotificationAvatar();

    if (!isElectron() || !enabled || !assistantId) {
      return;
    }

    const render = resolveAvatarRender(
      customImageUrl,
      components,
      traits,
      NOTIFICATION_AVATAR_SIZE,
    );
    if (render.kind === "none") {
      return;
    }

    let cancelled = false;
    const src = render.kind === "character" ? render.dataUri : render.url;
    void rasterizeNotificationAvatar(src, accentHex)
      .then(async (png) => {
        if (cancelled || !png) {
          return;
        }
        const hash = await sha256Hex(png);
        if (!cancelled) {
          setNotificationAvatar(assistantId, png, hash);
        }
      })
      .catch(() => {
        if (!cancelled) {
          clearNotificationAvatar();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, assistantId, customImageUrl, components, traits, accentHex]);
}
