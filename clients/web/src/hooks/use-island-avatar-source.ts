import { useEffect } from "react";

import { resolveAvatarRender, type AvatarRender } from "@/utils/avatar-render";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

/**
 * Size the character avatar is composited at before rasterizing. The SVG is
 * resolution-independent, so this only sets the ceiling the encoder's ladder
 * scales down from; it is not the size the island renders.
 */
const SOURCE_SIZE = 128;

/**
 * The avatar `useLiveActivityMirror` should send to iOS, or null when there is
 * none. Published rather than subscribed for the same reason as the rendered
 * accent hex in `use-avatar-accent-var.ts`: the mirror runs entirely inside an
 * effect, deliberately holding no reactive subscription, so it reads this
 * imperatively at the moment a session starts.
 */
let islandAvatarSource: AvatarRender | null = null;

/** The current avatar source for non-React readers. See {@link useIslandAvatarSource}. */
export function getIslandAvatarSource(): AvatarRender | null {
  return islandAvatarSource;
}

/**
 * Publish the assistant's avatar for the iOS Live Activity.
 *
 * Mounted in `RootLayout` alongside the favicon, Electron icon and accent-var
 * syncs, all of which consume the same avatar query and resolve their source
 * through `resolveAvatarRender` so no surface can drift onto a different
 * avatar than the one the user is looking at.
 *
 * This publishes the *unrasterized* render. Turning it into bytes costs a
 * canvas draw, and the overwhelmingly common case is a user who never starts a
 * voice session at all, so the encode is deferred to the mirror and happens at
 * most once per session rather than on every avatar change.
 *
 * Publish-only with no cleanup, matching `useAvatarAccentVar`: clearing on
 * unmount would make a second mount order-dependent, and a stale avatar is a
 * better failure than none.
 */
export function useIslandAvatarSource(
  customImageUrl: string | null,
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
): void {
  useEffect(() => {
    islandAvatarSource = resolveAvatarRender(
      customImageUrl,
      components,
      traits,
      SOURCE_SIZE,
    );
  }, [customImageUrl, components, traits]);
}
