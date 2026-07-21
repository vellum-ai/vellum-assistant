import { useEffect } from "react";

import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

/**
 * The CSS custom property carrying the active assistant's avatar accent hex
 * (e.g. `#E9642F` for the orange character). Set on `<html>` by
 * {@link useAvatarAccentVar}; absent when no character avatar is active
 * (custom-image avatars, `kind: "none"`, avatar still loading), so consumers
 * must read it with a `var(--avatar-accent, <fallback>)` fallback.
 */
export const AVATAR_ACCENT_CSS_VAR = "--avatar-accent";

/**
 * Resolve the accent hex for a character avatar's selected color id, checking
 * the daemon-served palette first and falling back to the bundled copy so the
 * hex resolves even before `character-components` loads.
 */
export function resolveAvatarAccentHex(
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
): string | null {
  const colorId = traits?.color;
  if (!colorId) {
    return null;
  }
  const palette = components?.colors ?? BUNDLED_COMPONENTS.colors;
  return palette.find((c) => c.id === colorId)?.hex ?? null;
}

/**
 * Publishes the avatar accent as `--avatar-accent` on the document root so
 * any component can tint itself to the assistant's color from plain CSS —
 * no query subscription needed at the consumption site. Mounted once in
 * `RootLayout` next to the favicon / Electron icon syncs, which derive from
 * the same avatar query.
 */
export function useAvatarAccentVar(
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
): void {
  const hex = resolveAvatarAccentHex(components, traits);
  useEffect(() => {
    const root = document.documentElement;
    if (hex) {
      root.style.setProperty(AVATAR_ACCENT_CSS_VAR, hex);
    } else {
      root.style.removeProperty(AVATAR_ACCENT_CSS_VAR);
    }
    return () => {
      root.style.removeProperty(AVATAR_ACCENT_CSS_VAR);
    };
  }, [hex]);
}
