import { useEffect } from "react";

import { contrastForeground } from "@/utils/avatar-tone";

/**
 * The CSS custom property carrying the active assistant's avatar accent hex
 * (e.g. `#E9642F` for the orange character). Set on `<html>` by
 * {@link useAvatarAccentVar}; absent while the avatar has no colour (still
 * loading, or an uploaded image the daemon could not read), so consumers
 * read it with a `var(--avatar-accent, <fallback>)` fallback.
 */
export const AVATAR_ACCENT_CSS_VAR = "--avatar-accent";

/**
 * The ink that reads on a surface filled with that accent: black or white,
 * whichever wins on WCAG contrast (`contrastForeground`). The accent carries no
 * luminance guarantee, and the palette's yellow is light enough that white text
 * on it is about 1.6:1, so any surface that fills itself with the accent takes
 * its foreground from here rather than assuming white.
 *
 * Published and cleared alongside {@link AVATAR_ACCENT_CSS_VAR}, so the same
 * `var(--avatar-accent, <fallback>)` reasoning applies: absent means there is
 * no accent, and the consumer's own fallback ink stands.
 */
export const AVATAR_ACCENT_INK_CSS_VAR = "--avatar-accent-ink";

/**
 * The accent pair as an inline style, for an element that scopes the accent to
 * itself rather than reading the document's. Empty for an assistant with no
 * accent, which leaves every consumer on its own fallback.
 *
 * One function so the two vars cannot be published apart: an element carrying
 * an accent with no ink is a filled surface guessing at its own foreground.
 */
export function avatarAccentVars(
  accentHex: string | null | undefined,
): Record<string, string> {
  if (!accentHex) {
    return {};
  }
  return {
    [AVATAR_ACCENT_CSS_VAR]: accentHex,
    [AVATAR_ACCENT_INK_CSS_VAR]: contrastForeground(accentHex),
  };
}

/** Every property {@link useAvatarAccentVar} owns on the document root. */
const ACCENT_VAR_NAMES = [
  AVATAR_ACCENT_CSS_VAR,
  AVATAR_ACCENT_INK_CSS_VAR,
] as const;

/**
 * Latest value published by {@link useAvatarAccentVar}, for readers that
 * cannot subscribe to the avatar query.
 *
 * The avatar lives in React Query, so every reactive reader needs a
 * `QueryClientProvider` and re-renders when it settles. That is wrong for
 * imperative platform mirrors: the iOS Live Activity mirror runs entirely
 * inside an effect at `ChatLayout` scope specifically so session churn never
 * re-renders the layout. `RootLayout` already holds the avatar for the active
 * assistant, so it publishes here once and those readers just look.
 *
 * {@link useAvatarAccentVar} is mounted in exactly one place, so in practice
 * there is one publisher, but nothing enforces that, so it only ever *writes*
 * this, never clears it. A second or transient mount can therefore not null
 * out what the surviving publisher published.
 */
let publishedAvatarAccentHex: string | null = null;

/**
 * The active assistant's avatar accent as `RootLayout` last published it, or
 * null before it has published one / while the avatar has no colour.
 */
export function getPublishedAvatarAccentHex(): string | null {
  return publishedAvatarAccentHex;
}

/**
 * Publishes the avatar accent as `--avatar-accent`, and the ink that reads on
 * it as `--avatar-accent-ink`, on the document root so any component can tint
 * itself to the assistant's colour from plain CSS, with no query subscription
 * at the consumption site, and as the value
 * {@link getPublishedAvatarAccentHex} hands to non-React readers. Mounted
 * once in `RootLayout` next to the favicon / Electron icon syncs, fed the
 * `accentHex` the avatar query resolves (see `utils/avatar-accent.ts`).
 */
export function useAvatarAccentVar(accentHex: string | null): void {
  useEffect(() => {
    const root = document.documentElement;
    const vars = avatarAccentVars(accentHex);
    for (const name of ACCENT_VAR_NAMES) {
      const value = vars[name];
      if (value) {
        root.style.setProperty(name, value);
      } else {
        root.style.removeProperty(name);
      }
    }
    return () => {
      for (const name of ACCENT_VAR_NAMES) {
        root.style.removeProperty(name);
      }
    };
  }, [accentHex]);

  // Publish-only, with no cleanup. "One publisher" is a convention, not
  // something the module can enforce, and clearing on unmount makes a second or
  // transient mount wipe the surviving publisher's value on the way out, which
  // the survivor never re-publishes because its own dep did not change. A
  // stale accent beats a null one: the next publish overwrites it, whereas null
  // silently downgrades the island to the native neutral gray. Nothing here is
  // per-mount state, so there is nothing to leak.
  useEffect(() => {
    publishedAvatarAccentHex = accentHex;
  }, [accentHex]);
}
