import { useEffect } from "react";

import { composeSvg } from "@/domains/avatar/svg-compositor.js";
import type { CharacterComponents, CharacterTraits } from "@/domains/avatar/types.js";

const FAVICON_SIZE = 32;
const DEFAULT_FAVICON = "/favicon.svg";

/**
 * Dynamically replaces the document favicon with the assistant's avatar.
 *
 * Priority matches ChatAvatar:
 *   1. Character SVG (when components + explicit traits are available)
 *   2. Custom uploaded image (blob URL or remote URL)
 *   3. Default Vellum favicon
 */
export function useDynamicFavicon(
  customImageUrl: string | null,
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
): void {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;

    let href: string | null = null;

    if (components && traits) {
      try {
        const svg = composeSvg(
          components,
          traits.bodyShape,
          traits.eyeStyle,
          traits.color,
          FAVICON_SIZE,
        );
        href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      } catch {
        // composeSvg throws on unknown IDs — fall through to image or default
      }
    }

    if (!href && customImageUrl) {
      href = customImageUrl;
    }

    link.href = href ?? DEFAULT_FAVICON;

    return () => {
      link.href = DEFAULT_FAVICON;
    };
  }, [customImageUrl, components, traits]);
}
