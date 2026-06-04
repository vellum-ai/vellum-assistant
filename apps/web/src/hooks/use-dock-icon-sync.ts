import { useEffect } from "react";

import { setDockIcon } from "@/runtime/dock";
import { isElectron } from "@/runtime/is-electron";
import { composeSvg } from "@/utils/avatar-svg-compositor";
import { rasterizeImageToPng, rasterizeSvgToPng } from "@/lib/rasterize";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

// macOS renders the Dock icon large; 512px stays crisp on Retina without the
// cost of a 1024 raster on every avatar change.
const DOCK_ICON_SIZE = 512;

type DockIconSource =
  | { kind: "character"; svg: string }
  | { kind: "image"; url: string }
  | { kind: "none" };

/**
 * Decide what the Dock icon should show from the avatar data, mirroring the
 * ChatAvatar / favicon precedence: explicit character traits win, then a
 * custom uploaded image, otherwise nothing (reset to the branded icon).
 * Pure + exported so the precedence is unit-testable without a canvas.
 */
export function selectDockIconSource(
  customImageUrl: string | null,
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
): DockIconSource {
  if (components && traits) {
    try {
      return {
        kind: "character",
        svg: composeSvg(
          components,
          traits.bodyShape,
          traits.eyeStyle,
          traits.color,
          DOCK_ICON_SIZE,
        ),
      };
    } catch {
      // composeSvg throws on unknown IDs — fall through to image/none.
    }
  }
  if (customImageUrl) return { kind: "image", url: customImageUrl };
  return { kind: "none" };
}

async function renderDockIcon(source: DockIconSource): Promise<string | null> {
  switch (source.kind) {
    case "character":
      return rasterizeSvgToPng(source.svg, DOCK_ICON_SIZE);
    case "image":
      return rasterizeImageToPng(source.url, DOCK_ICON_SIZE);
    case "none":
      return null;
  }
}

/**
 * Keep the macOS Dock icon in sync with the active assistant's avatar
 * (character SVG or custom image), falling back to the bundled branded icon
 * when there's no avatar. Electron-only — gated on `isElectron()` so web /
 * iOS skip the canvas work entirely.
 *
 * Mount once at the app root alongside `useDynamicFavicon`, fed from the same
 * `useAssistantAvatar` data, so the Dock, favicon, and in-app avatar stay in
 * lockstep across every authenticated route.
 */
export function useDockIconSync(
  customImageUrl: string | null,
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
): void {
  useEffect(() => {
    if (!isElectron()) return;
    let cancelled = false;
    void (async () => {
      const dataUrl = await renderDockIcon(
        selectDockIconSource(customImageUrl, components, traits),
      );
      // A newer avatar change may have superseded this render mid-flight;
      // dropping the stale result avoids a flash of the previous avatar.
      if (cancelled) return;
      await setDockIcon(dataUrl);
    })();
    return () => {
      cancelled = true;
    };
  }, [customImageUrl, components, traits]);

  // Reset to the branded icon when the app root unmounts (logout / teardown)
  // so a stale assistant avatar doesn't linger on the Dock once signed out.
  // Mount-only — kept out of the per-change effect above so normal avatar
  // updates don't flash through the default icon.
  useEffect(() => {
    if (!isElectron()) return;
    return () => {
      void setDockIcon(null);
    };
  }, []);
}
