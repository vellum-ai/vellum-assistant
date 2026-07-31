import { useEffect } from "react";

import { isElectron } from "@/runtime/is-electron";
import { setAssistantIcon } from "@/runtime/icon";
import { rasterizeAvatar } from "@/utils/avatar-raster";
import { resolveAvatarRender } from "@/utils/avatar-render";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

/**
 * Square the avatar is rasterized to before publishing. 512px covers the
 * largest consumer (the macOS Dock icon); main downsamples for the menu-bar
 * Tray. Matches the native app's avatar rendering size.
 */
const ICON_SIZE = 512;

/**
 * Publish the assistant's avatar to the Electron host so the main process can
 * drive both icon surfaces — the macOS Dock icon and the menu-bar Tray base
 * image — from one source, mirroring the native app where the same avatar
 * feeds `applicationIconImage` and the menu-bar item.
 *
 * Source precedence (character SVG → custom image → none) is shared with the
 * browser favicon via `resolveAvatarRender`, so the two surfaces never drift.
 * The renderer rasterizes because Electron's `nativeImage` only decodes
 * PNG/JPEG, not the trait-composited SVG; main owns per-surface masking and
 * the bundled-Vellum-mark fallback. Publishing `null` (no avatar, or a
 * rasterization failure) tells main to restore that fallback.
 *
 * Everything no-ops off Electron — `rasterizeAvatar` is gated behind
 * `isElectron()` so web/iOS hosts never do the canvas work. Mounted in
 * `RootLayout` next to the favicon sync so both consume the same avatar data.
 */
export function useElectronIconSync(
  customImageUrl: string | null,
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
): void {
  useEffect(() => {
    if (!isElectron()) {
      return;
    }

    const render = resolveAvatarRender(
      customImageUrl,
      components,
      traits,
      ICON_SIZE,
    );
    if (render.kind === "none") {
      setAssistantIcon(null);
      return;
    }

    let cancelled = false;
    const src = render.kind === "character" ? render.dataUri : render.url;
    void rasterizeAvatar(src, ICON_SIZE)
      .then((bytes) => {
        if (!cancelled) {
          setAssistantIcon(bytes);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAssistantIcon(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [customImageUrl, components, traits]);
}
