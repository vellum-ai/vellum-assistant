import { useEffect } from "react";

import { resolveAvatarRender } from "@/utils/avatar-render";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

const FAVICON_SIZE = 32;
const DEFAULT_FAVICON = "/favicon.svg";

/**
 * Dynamically replaces the document favicon with the assistant's avatar.
 *
 * Source precedence (character SVG → custom image → default) is owned by
 * `resolveAvatarRender`, shared with the Electron dock/menu-bar icon pipeline
 * so the two surfaces always render the same avatar.
 */
export function useDynamicFavicon(
  customImageUrl: string | null,
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
): void {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;

    const render = resolveAvatarRender(
      customImageUrl,
      components,
      traits,
      FAVICON_SIZE,
    );

    link.href =
      render.kind === "character"
        ? render.dataUri
        : render.kind === "image"
          ? render.url
          : DEFAULT_FAVICON;

    return () => {
      link.href = DEFAULT_FAVICON;
    };
  }, [customImageUrl, components, traits]);
}
