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
 * Accent hex of the avatar as `ChatAvatar` *actually renders it*.
 *
 * {@link resolveAvatarAccentHex} resolves only an *explicit* trait color and
 * returns null otherwise — but a traits-less assistant still renders in color,
 * because `ChatAvatar` falls back to the first palette color. Surfaces that
 * tint themselves to the avatar the user is looking at (the voice room's
 * listening waves, the iOS Live Activity) must mirror that fallback, or a
 * default-avatar assistant gets an indigo/gray treatment beside its green
 * avatar.
 *
 * Null for custom-image / no-character avatars — there is no color to match.
 * `customImageUrl` gates that explicitly rather than being inferred from the
 * absence of components: an uploaded avatar can carry lingering character
 * components, but the image is what renders, so no character color must leak
 * into a surface tinting itself to "the avatar you are looking at".
 */
export function resolveRenderedAvatarAccentHex(
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
  customImageUrl: string | null,
): string | null {
  if (customImageUrl) {
    return null;
  }
  return (
    resolveAvatarAccentHex(components, traits) ??
    components?.colors?.[0]?.hex ??
    null
  );
}

/**
 * Latest value published by {@link useAvatarAccentVar}, for readers that
 * cannot subscribe to the avatar query.
 *
 * The avatar lives in React Query, so every reactive reader needs a
 * `QueryClientProvider` and re-renders when it settles. That is wrong for
 * imperative platform mirrors — the iOS Live Activity mirror runs entirely
 * inside an effect at `ChatLayout` scope specifically so session churn never
 * re-renders the layout. `RootLayout` already holds the avatar for the active
 * assistant, so it publishes here once and those readers just look.
 *
 * {@link useAvatarAccentVar} is mounted in exactly one place, so in practice
 * there is one publisher — but nothing enforces that, so it only ever *writes*
 * this, never clears it. A second or transient mount can therefore not null out
 * what the surviving publisher published.
 */
let renderedAvatarAccentHex: string | null = null;

/**
 * The active assistant's rendered avatar accent (see
 * {@link resolveRenderedAvatarAccentHex}), or null before `RootLayout` has
 * published one / when the avatar has no color to match.
 */
export function getRenderedAvatarAccentHex(): string | null {
  return renderedAvatarAccentHex;
}

/**
 * Publishes the avatar accent as `--avatar-accent` on the document root so
 * any component can tint itself to the assistant's color from plain CSS —
 * no query subscription needed at the consumption site. Mounted once in
 * `RootLayout` next to the favicon / Electron icon syncs, which derive from
 * the same avatar query.
 *
 * It also publishes the *rendered* accent for non-React readers — see
 * {@link getRenderedAvatarAccentHex}. The two deliberately differ: the CSS var
 * stays the strict "explicit trait color" signal its consumers expect (a
 * default avatar leaves `var(--avatar-accent, …)` on its fallback), while the
 * rendered accent carries the palette fallback the avatar is actually drawn
 * with.
 */
export function useAvatarAccentVar(
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
  customImageUrl: string | null,
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

  const renderedHex = resolveRenderedAvatarAccentHex(
    components,
    traits,
    customImageUrl,
  );
  // Publish-only, with no cleanup. "One publisher" is a convention, not
  // something the module can enforce, and clearing on unmount makes a second or
  // transient mount wipe the surviving publisher's value on the way out — which
  // the survivor never re-publishes, because its own dep did not change. A
  // stale accent beats a null one: the next publish overwrites it, whereas null
  // silently downgrades the island to the native neutral gray. Nothing here is
  // per-mount state, so there is nothing to leak.
  useEffect(() => {
    renderedAvatarAccentHex = renderedHex;
  }, [renderedHex]);
}
